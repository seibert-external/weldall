import { z } from "zod";
import { GitAppError } from "../../errors.js";
import { githubApi } from "./api.js";
import { createAppJwt } from "./jwt.js";

export type GitHubPermissionLevel = "read" | "write";
/** Installation permission names as GitHub spells them, e.g. `contents` or `pull_requests`. */
export type GitHubPermissions = Readonly<Record<string, GitHubPermissionLevel>>;

export interface GitHubAppIdentity {
  apiBaseUrl: string;
  appId: string;
  organization: string;
  installationId?: string | undefined;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

/** A cached token is reused only while it stays valid for at least this long (a git push may take minutes). */
export const TOKEN_RENEWAL_MARGIN_MS = 5 * 60_000;
/**
 * How long a refused token request (GitHub's 422) is remembered for callers that opt in
 * (`reuseRefusal`, the status read's parts). A status read asks for checks, commit statuses and
 * deployments on every call and a publish reads status twice, so without this each read repeats
 * the same refused requests. Five minutes keeps that to one refusal per repository and permission
 * set every five minutes, while a permission granted later is picked up within five minutes
 * without a restart. Only refusals are remembered here; tokens keep their own expiry.
 */
export const TOKEN_REFUSAL_TTL_MS = 5 * 60_000;
/** Installation ids change only when the App is reinstalled. */
const INSTALLATION_LOOKUP_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 500;

const permissionName = /^[a-z][a-z_]{0,63}$/;

/**
 * Permissions the installation must have for creating a repository from a template; checked on
 * the installation-wide creation token, not requested (see `mintRepositoryCreationToken`).
 * `contents` may also be `write`.
 */
export const REPOSITORY_CREATION_PERMISSIONS = {
  contents: "read",
  repository_creation: "write",
} as const satisfies GitHubPermissions;

const tokenResponse = z.object({
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()).optional(),
  repositories: z.array(z.object({ name: z.string() })).optional(),
});
const installationResponse = z.object({ id: z.number().int().positive() });

/** Lets one caller stop waiting without cancelling a request other callers share. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Canonical, validated permission set; also the cache key component. */
function canonicalPermissions(permissions: GitHubPermissions): [string, GitHubPermissionLevel][] {
  const entries = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b));
  if (
    !entries.length ||
    entries.some(
      ([name, level]) => !permissionName.test(name) || (level !== "read" && level !== "write"),
    )
  )
    throw new GitAppError("invalid_permissions", "Request at least one valid permission.");
  return entries;
}

/** Status-only mapping: GitHub response bodies are never surfaced. */
function upstreamError(status: number, subject: "token" | "installation"): GitAppError {
  if (status === 401)
    return new GitAppError(
      "credential_rejected",
      "GitHub rejected the App credential. Check the App ID and the provisioned private key.",
      502,
    );
  if (status === 404)
    return new GitAppError(
      "installation_not_found",
      subject === "installation"
        ? "The GitHub App is not installed on the configured organisation."
        : "The GitHub App installation was not found.",
      502,
    );
  if (status === 422)
    return new GitAppError(
      "token_refused",
      "GitHub refused the token: the repository is not in the installation or a permission is not granted to the App.",
      502,
    );
  if (status === 403 || status === 429)
    return new GitAppError("upstream_rate_limited", "GitHub is rate limiting the App.", 503);
  return new GitAppError("upstream_unavailable", "GitHub is unavailable.", 503);
}

/**
 * Mints installation tokens restricted to one repository and an explicit permission set, and
 * caches them per installation, repository and permission set until shortly before expiry.
 * Concurrent requests for the same key share one upstream call.
 *
 * A refusal (`token_refused`) is remembered under the same key for {@link TOKEN_REFUSAL_TTL_MS}
 * and answered from memory only to callers that pass `reuseRefusal`. The key includes the
 * repository because GitHub's 422 does not say whether the permission is missing or the
 * repository left the installation, so one repository's refusal says nothing about another's.
 */
export function createInstallationTokenCache({ now = Date.now }: { now?: () => number } = {}) {
  const tokens = new Map<string, InstallationToken>();
  const pending = new Map<string, Promise<InstallationToken>>();
  const installations = new Map<string, { id: string; until: number }>();
  /** Keys whose last token request GitHub refused, until when that answer is reused. */
  const refusals = new Map<string, number>();

  const rememberRefusal = (key: string) => {
    for (const [refused, until] of refusals) if (until <= now()) refusals.delete(refused);
    while (refusals.size >= MAX_CACHE_ENTRIES) refusals.delete(refusals.keys().next().value!);
    refusals.set(key, now() + TOKEN_REFUSAL_TTL_MS);
  };

  const prune = () => {
    for (const [key, value] of tokens)
      if (value.expiresAt.getTime() - now() <= TOKEN_RENEWAL_MARGIN_MS) tokens.delete(key);
    while (tokens.size >= MAX_CACHE_ENTRIES) tokens.delete(tokens.keys().next().value!);
  };

  async function resolveInstallation(input: {
    app: GitHubAppIdentity;
    jwt: () => Promise<string>;
    signal: AbortSignal;
  }): Promise<string> {
    if (input.app.installationId) return input.app.installationId;
    const key = JSON.stringify([input.app.apiBaseUrl, input.app.appId, input.app.organization]);
    const cached = installations.get(key);
    if (cached && cached.until > now()) return cached.id;
    const { status, json } = await githubApi({
      apiBaseUrl: input.app.apiBaseUrl,
      path: `/orgs/${encodeURIComponent(input.app.organization)}/installation`,
      method: "GET",
      token: await input.jwt(),
      signal: input.signal,
    });
    if (status !== 200) throw upstreamError(status, "installation");
    const parsed = installationResponse.safeParse(json);
    if (!parsed.success)
      throw new GitAppError("upstream_protocol_error", "GitHub sent an invalid response.", 502);
    const id = String(parsed.data.id);
    if (installations.size >= MAX_CACHE_ENTRIES) installations.clear();
    installations.set(key, { id, until: now() + INSTALLATION_LOOKUP_TTL_MS });
    return id;
  }

  async function request(input: {
    app: GitHubAppIdentity;
    installationId: string;
    jwt: () => Promise<string>;
    repository: string;
    permissions: [string, GitHubPermissionLevel][];
    signal: AbortSignal;
  }): Promise<InstallationToken> {
    const { status, json } = await githubApi({
      apiBaseUrl: input.app.apiBaseUrl,
      path: `/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
      method: "POST",
      token: await input.jwt(),
      body: {
        repositories: [input.repository],
        permissions: Object.fromEntries(input.permissions),
      },
      signal: input.signal,
    });
    if (status !== 201) throw upstreamError(status, "token");
    const parsed = tokenResponse.safeParse(json);
    if (!parsed.success)
      throw new GitAppError("upstream_protocol_error", "GitHub sent an invalid response.", 502);
    const { token, expires_at, permissions, repositories } = parsed.data;
    const requested = new Map(input.permissions);
    // Fail closed unless GitHub confirms exactly the request: a missing `repositories` means all
    // repositories of the installation, a missing `permissions` an unknown set (metadata:read is implicit).
    if (
      !repositories ||
      repositories.length !== 1 ||
      repositories[0]!.name.toLowerCase() !== input.repository.toLowerCase() ||
      !permissions ||
      Object.entries(permissions).some(
        ([name, level]) =>
          !(name === "metadata" && level === "read") &&
          !(requested.get(name) === level || (requested.get(name) === "write" && level === "read")),
      )
    )
      throw new GitAppError("grant_mismatch", "GitHub issued a broader token than requested.", 502);
    const expiresAt = new Date(expires_at);
    if (expiresAt.getTime() - now() <= TOKEN_RENEWAL_MARGIN_MS)
      throw new GitAppError("upstream_protocol_error", "GitHub sent an expired token.", 502);
    return { token, expiresAt };
  }

  return {
    async mint(input: {
      app: GitHubAppIdentity;
      /** Decrypts the App's private key; called only on a cache miss. */
      loadPrivateKey: () => Promise<string>;
      repository: string;
      permissions: GitHubPermissions;
      signal: AbortSignal;
      /**
       * Answer with a refusal GitHub gave for the same key within {@link TOKEN_REFUSAL_TTL_MS}
       * instead of asking again. For reads that only turn a refusal into a warning; the
       * checklist and every operation that acts on the repository always ask GitHub.
       */
      reuseRefusal?: boolean;
    }): Promise<InstallationToken> {
      const permissions = canonicalPermissions(input.permissions);
      let jwt: string | undefined;
      const appJwt = async () =>
        (jwt ??= createAppJwt({
          appId: input.app.appId,
          privateKey: await input.loadPrivateKey(),
          now: now(),
        }));
      const installationId = await resolveInstallation({
        app: input.app,
        jwt: appJwt,
        signal: input.signal,
      });
      const key = JSON.stringify([
        input.app.apiBaseUrl,
        input.app.appId,
        installationId,
        input.repository,
        permissions,
      ]);
      const cached = tokens.get(key);
      if (cached && cached.expiresAt.getTime() - now() > TOKEN_RENEWAL_MARGIN_MS) return cached;
      const refusedUntil = refusals.get(key);
      if (input.reuseRefusal && refusedUntil !== undefined && refusedUntil > now())
        throw upstreamError(422, "token");
      const inFlight = pending.get(key);
      if (inFlight) return untilAborted(inFlight, input.signal);
      const minted = request({
        app: input.app,
        installationId,
        jwt: appJwt,
        repository: input.repository,
        permissions,
        // Shared by concurrent callers, so bounded only by the request timeout.
        signal: new AbortController().signal,
      })
        .then(
          (token) => {
            prune();
            tokens.set(key, token);
            refusals.delete(key);
            return token;
          },
          (error: unknown) => {
            if (error instanceof GitAppError && error.code === "token_refused")
              rememberRefusal(key);
            throw error;
          },
        )
        .finally(() => pending.delete(key));
      pending.set(key, minted);
      return untilAborted(minted, input.signal);
    },
    /**
     * Mints the installation-wide token for one `POST /repos/{template}/generate` call: the request
     * body names no repositories and no permissions, so the token carries every permission of
     * the installation on every repository it covers. It is never cached; the caller must use it
     * for that one call only and pass it nowhere else.
     *
     * Why unrestricted (measured against GitHub on 17.11.2026, see the plan's SCHRITTE.md,
     * "Zweiter Nachtrag"): `generate` answered 422 "Could not clone" for a token restricted to
     * the template repository, and also for tokens without a repository restriction but with
     * `permissions` {repository_creation: write, contents: read or write}; each failure left an
     * empty repository behind. Only a token minted with an empty body created the repository.
     * Do not narrow this token again without repeating that test.
     *
     * Before returning, the token's permissions must include {@link REPOSITORY_CREATION_PERMISSIONS};
     * otherwise this fails with `repository_creation_not_permitted`, before `generate` could
     * strand an empty repository.
     */
    async mintRepositoryCreationToken(input: {
      app: GitHubAppIdentity;
      loadPrivateKey: () => Promise<string>;
      signal: AbortSignal;
    }): Promise<InstallationToken> {
      const jwt = createAppJwt({
        appId: input.app.appId,
        privateKey: await input.loadPrivateKey(),
        now: now(),
      });
      const installationId = await resolveInstallation({
        app: input.app,
        jwt: async () => jwt,
        signal: input.signal,
      });
      const { status, json } = await githubApi({
        apiBaseUrl: input.app.apiBaseUrl,
        path: `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        method: "POST",
        token: jwt,
        body: {},
        signal: input.signal,
      });
      if (status !== 201) throw upstreamError(status, "token");
      const parsed = tokenResponse.safeParse(json);
      if (!parsed.success)
        throw new GitAppError("upstream_protocol_error", "GitHub sent an invalid response.", 502);
      const { token, expires_at, permissions = {} } = parsed.data;
      const missing = Object.entries(REPOSITORY_CREATION_PERMISSIONS)
        .filter(([name, level]) => {
          const granted = permissions[name];
          return !(granted === level || (level === "read" && granted === "write"));
        })
        .map(([name, level]) => `${name}: ${level}`);
      if (missing.length)
        throw new GitAppError(
          "repository_creation_not_permitted",
          `The GitHub App installation lacks ${missing.join(" and ")}, which creating a repository from a template needs. Grant the App "Repository creation: write" and "Contents: read" and accept the updated permissions on the installation.`,
          502,
        );
      const expiresAt = new Date(expires_at);
      if (expiresAt.getTime() - now() <= TOKEN_RENEWAL_MARGIN_MS)
        throw new GitAppError("upstream_protocol_error", "GitHub sent an expired token.", 502);
      return { token, expiresAt };
    },
    clear() {
      tokens.clear();
      installations.clear();
      refusals.clear();
    },
  };
}
export type InstallationTokenCache = ReturnType<typeof createInstallationTokenCache>;

/** Process-wide cache; tokens never leave this server. */
export const installationTokens = createInstallationTokenCache();
