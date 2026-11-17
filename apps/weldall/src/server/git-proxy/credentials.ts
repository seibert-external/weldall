import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@weldall/db";
import { assertConnectorAccess } from "../connectors/access";
import { ConnectorError, type AuthorizedConnectorActor } from "../connectors/contracts";
import { writeGitCredentialAudit } from "../connectors/git-audit";
import { WELDALL_GIT_CREDENTIAL_PREFIX, type GitAccess } from "../connectors/git-host";
import { isAppRepositoryReady } from "../app-registry/service";
import { parseGitRemotePath } from "./paths";
import { resolveGitApp, type ResolvedGitApp } from "./resolve";

/**
 * Lifetime of a git credential. Git sends it with every request of one command (2 to 4) and the
 * proxy checks it when each request starts, so it must outlast the start of the last request of
 * one command, not the upload itself.
 */
export const GIT_CREDENTIAL_LIFETIME_MS = 5 * 60_000;
/** Git requires a username; the proxy ignores it. */
export const GIT_CREDENTIAL_USERNAME = "weldall";
/** One git command asks for one credential; a publish needs two (fetch, push). */
export const GIT_CREDENTIAL_ISSUE_LIMIT_PER_MINUTE = 20;

const SECRET_BYTES = 32;
const credentialPattern = new RegExp(
  `^${WELDALL_GIT_CREDENTIAL_PREFIX}([a-z0-9]{20,40})\\.([A-Za-z0-9_-]{43})$`,
);
const hash = (secret: string) => createHash("sha256").update(secret, "utf8").digest();
/** Compared against when the credential id is unknown, so both paths do the same work. */
const unknownHash = hash(randomBytes(SECRET_BYTES).toString("base64url"));

const toAccess = (access: GitAccess) => (access === "write" ? "WRITE" : "READ");
const fromAccess = (access: "READ" | "WRITE"): GitAccess => (access === "WRITE" ? "write" : "read");

export interface IssuedGitCredential {
  username: string;
  password: string;
  expiresAt: string;
}

/** Codes that reject the caller's request rather than report a failure of Weldall. */
const deniedCodes = new Set([
  "invalid_request",
  "connection_denied",
  "not_found",
  "disabled",
  "repository_not_ready",
  "rate_limit",
]);

/**
 * Issues a short-lived git credential for one of the caller's apps. Only the owner gets one, only
 * for a ready repository, and only while the caller may use the Git host connector. The secret is
 * returned once and stored as a SHA-256 hash; the credential row and its audit entry are written
 * in one transaction, so no credential exists without an `issued` entry.
 */
export async function issueGitCredential({
  actor,
  input,
  now = () => new Date(),
}: {
  actor: AuthorizedConnectorActor;
  input: { path: string; access: GitAccess };
  now?: () => Date;
}): Promise<IssuedGitCredential> {
  let resolved: ResolvedGitApp | null = null;
  try {
    if (actor.type === "machine")
      throw new ConnectorError(
        "connection_denied",
        "Git credentials are issued to people; sign in as a user.",
        403,
      );
    const path = parseGitRemotePath(input.path);
    if (!path)
      throw new ConnectorError(
        "invalid_request",
        "Expected a git proxy path like git/<connector>/<owner>/<repository>.git.",
      );
    resolved = await resolveGitApp(path);
    if (!resolved || resolved.app.ownerId !== actor.id)
      throw new ConnectorError("not_found", "No app of yours uses this repository.", 404);
    assertConnectorAccess({ connector: resolved.connector, actor });
    if (!resolved.connector.enabled)
      throw new ConnectorError("disabled", "The Git host connector is disabled.", 409);
    if (!isAppRepositoryReady(resolved.app))
      throw new ConnectorError(
        "repository_not_ready",
        "The app's repository is still being created. Retry the app creation first.",
        409,
      );
    const { app } = resolved;
    const issuedAt = now();
    // No scheduler cleans up: expired credentials are deleted whenever a new one is issued.
    await db.gitCredential.deleteMany({ where: { expiresAt: { lte: issuedAt } } });
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const expiresAt = new Date(issuedAt.getTime() + GIT_CREDENTIAL_LIFETIME_MS);
    const credential = await db.$transaction(async (tx) => {
      // Serialises issuance per person, so parallel requests cannot pass the limit together.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`git-credential:${actor.id}`}))`;
      const recent = await tx.gitCredential.count({
        where: { userId: actor.id, createdAt: { gt: new Date(issuedAt.getTime() - 60_000) } },
      });
      if (recent >= GIT_CREDENTIAL_ISSUE_LIMIT_PER_MINUTE)
        throw new ConnectorError(
          "rate_limit",
          "Too many git credentials requested. Retry next minute.",
          429,
        );
      const created = await tx.gitCredential.create({
        data: {
          secretHash: hash(secret),
          userId: actor.id,
          appId: app.id,
          access: toAccess(input.access),
          createdAt: issuedAt,
          expiresAt,
        },
      });
      await writeGitCredentialAudit({
        actor,
        tx,
        outcome: "success",
        connectorId: app.connectorId,
        appId: app.id,
        repository: { owner: app.repositoryOwner, name: app.repositoryName },
        credentialId: created.id,
        access: input.access,
        expiresAt,
      });
      return created;
    });
    return {
      username: GIT_CREDENTIAL_USERNAME,
      password: `${WELDALL_GIT_CREDENTIAL_PREFIX}${credential.id}.${secret}`,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    const known = error instanceof ConnectorError;
    // Another owner's app is neither linked nor named in this caller's rejection.
    const own = resolved?.app.ownerId === actor.id ? resolved.app : null;
    await writeGitCredentialAudit({
      actor,
      outcome: known && deniedCodes.has(error.code) ? "denied" : "failed",
      ...(known && error.code === "connection_denied"
        ? { reasonCode: "scope_not_granted" as const }
        : {}),
      reason: known ? error.message : "Issuing the git credential failed unexpectedly.",
      connectorId: own?.connectorId ?? null,
      appId: own?.id ?? null,
      repository: own ? { owner: own.repositoryOwner, name: own.repositoryName } : null,
      access: input.access,
    });
    throw error;
  }
}

export interface VerifiedGitCredential {
  id: string;
  userId: string;
  email: string;
  appId: string;
  access: GitAccess;
  expiresAt: Date;
}

export type GitCredentialCheck =
  | { status: "valid"; credential: VerifiedGitCredential }
  /** The secret matched, so the person is known, but the credential is no longer valid. */
  | { status: "expired"; credential: VerifiedGitCredential }
  | { status: "invalid" };

/**
 * Checks a password git sent with Basic auth. The secret's hash is compared in constant time; an
 * unknown id costs the same comparison. Expiry is checked when a request starts, never mid-transfer.
 */
export async function verifyGitCredential(
  password: string,
  now: Date = new Date(),
): Promise<GitCredentialCheck> {
  const match = credentialPattern.exec(password);
  if (!match) return { status: "invalid" };
  const [, id, secret] = match as unknown as [string, string, string];
  const row = await db.gitCredential.findUnique({
    where: { id },
    include: { user: { select: { email: true } } },
  });
  const presented = hash(secret);
  const stored = row ? Buffer.from(row.secretHash) : unknownHash;
  const equal = stored.length === presented.length && timingSafeEqual(stored, presented);
  if (!row || !equal) return { status: "invalid" };
  const credential = {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    appId: row.appId,
    access: fromAccess(row.access),
    expiresAt: row.expiresAt,
  };
  return row.expiresAt.getTime() <= now.getTime()
    ? { status: "expired", credential }
    : { status: "valid", credential };
}
