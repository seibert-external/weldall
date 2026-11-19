import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { appIdSchema, repositoryPartSchema, weldallSubjectSchema } from "@weldall/sdk";
import { WELDALL_GIT_CREDENTIAL_PREFIX, type GitAccess } from "../hosts/git-host.js";

/**
 * Short-lived git credentials for the git proxy, signed rather than stored (the Git app has no
 * database). A credential is
 *
 *     wgc_<key id>.<payload>.<mac>
 *
 * with `payload` the base64url JSON array `[1, subject, appId, owner, name, "r"|"w", exp, id]`
 * (`exp` in Unix seconds, `id` 16 random bytes) and `mac` the HMAC-SHA256 under the instance's
 * credential key over a fixed label, the instance's resource identifier, the key id and the
 * payload. Binding the resource keeps one instance's credentials from working at another that
 * shares the key. The `wgc_` prefix is the one the server's stored credentials used, so the
 * redaction patterns (`redaction.ts`) and the CLI's helper keep recognising it.
 *
 * Key rotation: the current key signs and verifies; one previous key may be configured that only
 * verifies. Put the new key in place, move the old one to the previous slot, and remove it after
 * {@link GIT_CREDENTIAL_LIFETIME_MS}. Credentials cannot be revoked one by one; the per-request
 * checks with Weldall (permission, ownership) do that job, and removing a key revokes everything
 * it signed.
 *
 * Accepted only by the git route: the API routes take DPoP-bound access tokens only.
 */

/**
 * Lifetime of a git credential. Git sends it with every request of one command (2 to 4) and the
 * proxy checks it when each request starts, so it must outlast the start of the last request of
 * one command, not the upload itself.
 */
export const GIT_CREDENTIAL_LIFETIME_MS = 5 * 60_000;
/** Git requires a username; the proxy ignores it. */
export const GIT_CREDENTIAL_USERNAME = "weldall";
/** Minimum size of a credential key. */
export const GIT_CREDENTIAL_KEY_MIN_BYTES = 32;

const VERSION = 1;
const MAC_LABEL = "weldall-git-credential-v1";
const KEY_ID_LABEL = "weldall-git-credential-key-id";
const credentialPattern = new RegExp(
  `^${WELDALL_GIT_CREDENTIAL_PREFIX}([A-Za-z0-9_-]{8})\\.([A-Za-z0-9_-]{1,2000})\\.([A-Za-z0-9_-]{43})$`,
);
const payloadSchema = z.tuple([
  z.literal(VERSION),
  weldallSubjectSchema,
  appIdSchema,
  repositoryPartSchema,
  repositoryPartSchema,
  z.enum(["r", "w"]),
  z.number().int().positive(),
  z.string().regex(/^[A-Za-z0-9_-]{22}$/),
]);

export interface GitCredentialClaims {
  /** Random id, reported as `credentialId` in the audit; never the credential itself. */
  id: string;
  /** Weldall user id of the person the credential was issued to. */
  subject: string;
  appId: string;
  /** The repository in the registry's spelling at issue time; compared case-insensitively. */
  repository: { owner: string; name: string };
  access: GitAccess;
  expiresAt: Date;
}

export type GitCredentialCheck =
  | { status: "valid"; credential: GitCredentialClaims }
  /** Signed by this instance, so the person is known, but no longer valid. */
  | { status: "expired"; credential: GitCredentialClaims }
  | { status: "invalid" };

const keyId = (key: Buffer) =>
  createHmac("sha256", key).update(KEY_ID_LABEL).digest("base64url").slice(0, 8);

/**
 * Signs and verifies git credentials with the instance's keys: `keys[0]` signs, every key
 * verifies. `resource` is the instance's resource identifier.
 */
export function createGitCredentialSigner({
  keys,
  resource,
  now = () => new Date(),
}: {
  keys: readonly Buffer[];
  resource: string;
  now?: () => Date;
}) {
  if (!keys.length || keys.some((key) => key.length < GIT_CREDENTIAL_KEY_MIN_BYTES))
    throw new Error("Git credential keys must have at least 32 bytes.");
  const ring = new Map(keys.map((key) => [keyId(key), key] as const));
  const current = { id: keyId(keys[0]!), key: keys[0]! };
  const mac = (key: Buffer, id: string, payload: string) =>
    createHmac("sha256", key).update(`${MAC_LABEL}\0${resource}\0${id}.${payload}`).digest();

  return {
    /** Issues a credential for `claims`; the id and expiry are chosen here. */
    issue(claims: Omit<GitCredentialClaims, "id" | "expiresAt">): {
      password: string;
      credential: GitCredentialClaims;
    } {
      const id = randomBytes(16).toString("base64url");
      const expiresAt = new Date(now().getTime() + GIT_CREDENTIAL_LIFETIME_MS);
      const payload = Buffer.from(
        JSON.stringify(
          payloadSchema.parse([
            VERSION,
            claims.subject,
            claims.appId,
            claims.repository.owner,
            claims.repository.name,
            claims.access === "write" ? "w" : "r",
            Math.floor(expiresAt.getTime() / 1000),
            id,
          ]),
        ),
      ).toString("base64url");
      const signature = mac(current.key, current.id, payload).toString("base64url");
      return {
        password: `${WELDALL_GIT_CREDENTIAL_PREFIX}${current.id}.${payload}.${signature}`,
        credential: {
          ...claims,
          id,
          // Second precision, as verification reads it back.
          expiresAt: new Date(Math.floor(expiresAt.getTime() / 1000) * 1000),
        },
      };
    },
    /**
     * Checks a password git sent with Basic auth. The MAC is compared in constant time; an unknown
     * key id costs the same computation. Expiry is checked when a request starts, never mid-transfer.
     */
    verify(password: string): GitCredentialCheck {
      const match = credentialPattern.exec(password);
      if (!match) return { status: "invalid" };
      const [, id, payload, signature] = match as unknown as [string, string, string, string];
      const key = ring.get(id);
      const expected = mac(key ?? current.key, id, payload);
      const presented = Buffer.from(signature, "base64url");
      const equal = presented.length === expected.length && timingSafeEqual(presented, expected);
      if (!key || !equal) return { status: "invalid" };
      let parsed;
      try {
        parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      } catch {
        return { status: "invalid" };
      }
      if (!parsed.success) return { status: "invalid" };
      const [, subject, appId, owner, name, access, exp, credentialId] = parsed.data;
      const credential: GitCredentialClaims = {
        id: credentialId,
        subject,
        appId,
        repository: { owner, name },
        access: access === "w" ? "write" : "read",
        expiresAt: new Date(exp * 1000),
      };
      return credential.expiresAt.getTime() <= now().getTime()
        ? { status: "expired", credential }
        : { status: "valid", credential };
    },
  };
}
export type GitCredentialSigner = ReturnType<typeof createGitCredentialSigner>;

/**
 * Decodes a configured credential key: base64 or base64url of at least
 * {@link GIT_CREDENTIAL_KEY_MIN_BYTES} random bytes (e.g. `openssl rand -base64 32`). Null when
 * it is not; the caller reports the variable name, never the value.
 */
export function parseGitCredentialKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  const key = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length >= GIT_CREDENTIAL_KEY_MIN_BYTES ? key : null;
}
