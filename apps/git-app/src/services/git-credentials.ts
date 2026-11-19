import { authorizePerson } from "../access.js";
import { GitAppError } from "../errors.js";
import { GIT_CREDENTIAL_USERNAME, type GitCredentialSigner } from "../git/credentials.js";
import { parseGitRemotePath, type GitRepositoryPath } from "../git/paths.js";
import type { GitAccess } from "../hosts/git-host.js";
import { lookupApp } from "../weldall.js";
import type { GitAppServices, Person } from "./context.js";

/** One git command asks for one credential; a publish needs two (fetch, push). */
export const GIT_CREDENTIAL_ISSUE_LIMIT_PER_MINUTE = 20;

export interface IssuedGitCredential {
  username: string;
  password: string;
  expiresAt: string;
}

/** Codes that reject the person's request rather than report a failure of the Git app or Weldall. */
const deniedCodes = new Set([
  "access_denied",
  "invalid_request",
  "not_found",
  "invalid_target",
  "repository_not_ready",
  "rate_limit",
]);

/**
 * Per-person issuance limit in this process (the server kept it in its database). Counts
 * credentials issued over the last minute. A request reserves its place synchronously, before
 * anything is awaited, so parallel requests cannot pass the limit together; a request that issues
 * nothing gives its place back, as the server counted only created credentials.
 */
export function createIssueLimiter(limit = GIT_CREDENTIAL_ISSUE_LIMIT_PER_MINUTE) {
  const issued = new Map<string, Array<{ time: number }>>();
  return {
    /** A reservation to give back with `cancel` when nothing is issued, or null over the limit. */
    reserve(subject: string, now: number): { cancel: () => void } | null {
      const recent = (issued.get(subject) ?? []).filter(({ time }) => time > now - 60_000);
      if (recent.length >= limit) {
        issued.set(subject, recent);
        return null;
      }
      const entry = { time: now };
      issued.set(subject, [...recent, entry]);
      return {
        cancel() {
          const left = (issued.get(subject) ?? []).filter((other) => other !== entry);
          if (left.length) issued.set(subject, left);
          else issued.delete(subject);
        },
      };
    },
  };
}
export type IssueLimiter = ReturnType<typeof createIssueLimiter>;

/**
 * Issues a short-lived git credential for one of the person's apps. Order: Weldall confirms the login permission and the publish scope,
 * then the app registry confirms that the repository belongs to a ready app of the person, and
 * `git_credential.issued` must be stored in Weldall before the credential is returned, so no
 * credential exists without its audit entry. Read access unless write is asked for explicitly.
 */
export async function issueGitCredential({
  services,
  signer,
  limiter,
  person,
  input,
  now = () => Date.now(),
}: {
  services: GitAppServices;
  signer: GitCredentialSigner;
  limiter: IssueLimiter;
  person: Person;
  input: { path: string; access: GitAccess };
  now?: () => number;
}): Promise<IssuedGitCredential> {
  let path: GitRepositoryPath | null = null;
  let ownAppId: string | null = null;
  // Reserved before the first await; given back in the catch, where nothing was issued.
  const reservation = limiter.reserve(person.id, now());
  try {
    if (!reservation)
      throw new GitAppError(
        "rate_limit",
        "Too many git credentials requested. Retry next minute.",
        429,
      );
    await authorizePerson(services.weldall, person.id, [services.scopes.publish]);
    path = parseGitRemotePath(input.path);
    if (!path)
      throw new GitAppError(
        "invalid_request",
        "Expected a git path like git/<owner>/<repository>.git.",
      );
    const found = await lookupApp(services.weldall, {
      app: { repositoryOwner: path.owner, repositoryName: path.name },
      subject: person.id,
    });
    if (!found || found.ownedBySubject !== true)
      throw new GitAppError("not_found", "No app of yours uses this repository.", 404);
    const { app } = found;
    ownAppId = app.id;
    if (app.repository.owner.toLowerCase() !== services.host.organization.toLowerCase())
      throw new GitAppError(
        "invalid_target",
        "The app's repository is not in this Git app's organisation.",
        409,
      );
    if (!app.ready)
      throw new GitAppError(
        "repository_not_ready",
        "The app's repository is still being created. Retry the app creation first.",
        409,
      );
    const { password, credential } = signer.issue({
      subject: person.id,
      appId: app.id,
      repository: { owner: app.repository.owner, name: app.repository.name },
      access: input.access,
    });
    // Without a stored audit entry the credential is never handed out (503 audit_unavailable).
    await services.audit.success({
      eventType: "git_credential.issued",
      subject: person.id,
      appId: app.id,
      details: {
        credentialId: credential.id,
        access: credential.access,
        expiresAt: credential.expiresAt.toISOString(),
      },
    });
    return {
      username: GIT_CREDENTIAL_USERNAME,
      password,
      expiresAt: credential.expiresAt.toISOString(),
    };
  } catch (error) {
    reservation?.cancel();
    const known = error instanceof GitAppError;
    if (!(known && error.code === "audit_unavailable"))
      await services.audit.rejection({
        eventType:
          known && deniedCodes.has(error.code) ? "git_credential.denied" : "git_credential.failed",
        ...(known && error.code === "access_denied"
          ? { reasonCode: "scope_not_granted" as const }
          : {}),
        reason: known ? error.message : "Issuing the git credential failed unexpectedly.",
        subject: person.id,
        // Another owner's app is never linked to this person's rejection; the repository is
        // named as the person asked for it.
        appId: ownAppId,
        repository: ownAppId || !path ? null : { owner: path.owner, name: path.name },
        details: { access: input.access },
      });
    throw error;
  }
}
