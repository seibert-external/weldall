import type { ResourceRegistryEntry } from "@weldall/sdk";
import { resolveWeldallConfig, selectIssuer, type WeldallConfig } from "../config.js";
import { CliError, ConfigurationError, errorMessage } from "../errors.js";
import { fetchAppRegistries, type AppRegistryListing } from "../services/apps.js";
import { connectResource, type PreparedResourceClient } from "../services/resources.js";
import { SessionManager, type AccessSession } from "../services/session-manager.js";
import type { GitCredentialAccess, GitCredentialRequest } from "./credential-helper.js";
import {
  describeRegistry,
  registriesAtOrigin,
  RegistryAccessError,
  scopeFor,
  trustedRegistries,
  type FoundRegistries,
  type OpenRegistry,
  type Registry,
  type RegistryAnswer,
  type RegistryNeed,
  type RegistryRequest,
} from "./registries.js";

/**
 * How the CLI reaches Weldall and the registries: the swappable seam between the protocol and
 * publish code and the person's login. The direct variants here use this device's CLI login
 * (keychain session, DPoP). Under a client's sandbox, the git credential helper runs inside the
 * sandbox and gets a {@link GitCredentialAccess} through the sandbox door instead; the door runs
 * outside with the person's session and must keep the checks of {@link gitCredentialAccess}: look
 * the origin up among the registries Weldall lists (`GET /api/me/apps`) and answer only for a URL
 * below such a registry's git route.
 */

const SETUP_TIMEOUT_MS = 30_000;
const CREDENTIAL_TIMEOUT_MS = 30_000;
/** Registry answers are read bounded; a status with 30 reviews is about 150 KB. */
const ANSWER_MAX_BYTES = 4 * 1024 * 1024;

/** Whether a fetch failed because its `AbortSignal.timeout` passed. */
const isTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "TimeoutError" ||
    (error.cause instanceof Error && error.cause.name === "TimeoutError"));

/** A transport failure as a {@link RegistryAccessError}: `timeout` when a deadline passed. */
const transportFailure = (error: unknown) =>
  isTimeout(error)
    ? new RegistryAccessError("timeout", "no answer in time", { cause: error })
    : new RegistryAccessError("network", networkMessage(error), { cause: error });

/** `fetch failed` alone says little; the cause names the refused connection or DNS failure. */
export const networkMessage = (error: unknown) => {
  const cause = error instanceof Error ? error.cause : undefined;
  const reason = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  return `${errorMessage(error)}${reason}`;
};

/** `Retry-After` as seconds (a number or an HTTP date), null when absent or unreadable. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : null;
}

/** Reads a registry's answer bounded; JSON when it parses, else the text, null when empty. */
async function readAnswer(response: Response): Promise<RegistryAnswer> {
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader?.read();
      if (!next || next.done) break;
      size += next.value.byteLength;
      if (size > ANSWER_MAX_BYTES) throw new CliError("The registry's answer is too large");
      chunks.push(next.value);
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown = text || null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: passed on as text.
  }
  return { status: response.status, body, retryAfter };
}

export interface DirectAccessDependencies {
  getSession?: (config: WeldallConfig, signal: AbortSignal) => Promise<AccessSession>;
}

interface Connection {
  registry: Registry;
  client: PreparedResourceClient;
}

/** Whether two openings reached the same registry with the same addresses and permission. */
const sameRegistry = (left: Registry, right: Registry) =>
  left.key === right.key &&
  left.origin === right.origin &&
  left.api === right.api &&
  left.git === right.git &&
  left.gitCredentials === right.gitCredentials &&
  left.publishScope === right.publishScope &&
  left.adminScope === right.adminScope &&
  left.resource.resourceIdentifier === right.resource.resourceIdentifier &&
  left.resource.downstreamClientId === right.resource.downstreamClientId;

/**
 * Opens registry clients with this device's CLI login: Weldall's list of registries
 * (`GET /api/me/apps`) and resource registry, read at once, the token exchange at Weldall and the
 * downstream token at the registry, all bounded by 30 s; each later request has its own timeout.
 * A missing login or an unreachable server is a {@link RegistryAccessError}; what `choose` throws
 * is passed on unchanged.
 *
 * The downstream token lives a few minutes, while a publish can take longer (creating an app,
 * pushing). When the registry answers 401, the client opens the registry once more (fresh session,
 * Weldall's lists, token exchange) and repeats the request once; only a second 401 reaches the
 * caller. Repeating is safe for every registry call: a 401 means the registry refused the token
 * before acting on the request, and the registry's calls are repeat-safe anyway (see
 * `createRegistryApi`). If the registry Weldall names changed meanwhile, the client stops instead.
 */
export function directOpenRegistry(
  config: WeldallConfig,
  dependencies: DirectAccessDependencies = {},
): OpenRegistry {
  const getSession =
    dependencies.getSession ??
    ((current: WeldallConfig, signal: AbortSignal) =>
      new SessionManager(current).getAccessSession(signal));

  const connect = async (
    choose: (found: FoundRegistries) => Registry,
    need: RegistryNeed,
  ): Promise<Connection> => {
    const setupSignal = AbortSignal.timeout(SETUP_TIMEOUT_MS);
    let session: AccessSession;
    try {
      session = await getSession(config, setupSignal);
    } catch (error) {
      // The session layer reports a missing login, a rejected refresh, or an unreadable store as
      // CliError; anything else is the transport failing.
      throw error instanceof CliError
        ? new RegistryAccessError("login", errorMessage(error), {
            cause: error,
            hint: "Run `weldall login`, then try again.",
          })
        : transportFailure(error);
    }
    // Read at the same time as the resource registry `connectResource` reads.
    const listing: Promise<AppRegistryListing[] | null> = fetchAppRegistries(
      config,
      session,
      setupSignal,
    );
    listing.catch(() => {});
    let chosen: Registry | undefined;
    let client: PreparedResourceClient;
    try {
      client = await connectResource(
        config,
        session,
        async (resources: ResourceRegistryEntry[]) => {
          chosen = choose(trustedRegistries(await listing, resources));
          return { resource: chosen.resource, scopes: [scopeFor(chosen, need)!] };
        },
        { setupSignal },
      );
    } catch (error) {
      if (error instanceof RegistryAccessError) throw error;
      if (chosen === undefined && error instanceof CliError) throw error;
      throw error instanceof CliError
        ? new RegistryAccessError("refused", errorMessage(error), {
            cause: error,
            ...(error.hint ? { hint: error.hint } : {}),
          })
        : transportFailure(error);
    }
    return { registry: chosen!, client };
  };

  const sendOnce = async (
    client: PreparedResourceClient,
    { method, url, body, timeoutMs }: RegistryRequest,
  ): Promise<RegistryAnswer> => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await client.send({
        url,
        method,
        ...(body === undefined ? {} : { json: body }),
        signal,
      });
      return await readAnswer(response);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw transportFailure(error);
    }
  };

  return async (choose, need) => {
    let current = await connect(choose, need);
    return {
      registry: current.registry,
      async send(request) {
        const answer = await sendOnce(current.client, request);
        if (answer.status !== 401) return answer;
        // The downstream token expired (or was revoked): one fresh token, one repeat.
        const next = await connect(choose, need);
        if (!sameRegistry(next.registry, current.registry))
          throw new RegistryAccessError(
            "refused",
            `The registration of ${describeRegistry(current.registry)} changed in Weldall while this command ran.`,
            { hint: "Run the same command again." },
          );
        current = next;
        return sendOnce(current.client, request);
      },
    };
  };
}

/**
 * The git credential helper's access over any {@link OpenRegistry}: answers only when `origin`
 * is the origin of exactly one registry Weldall lists (`GET /api/me/apps`) that publishes changes,
 * the URL lies below that registry's git route, and the person may publish there; then asks that
 * registry for a credential for `path` at the git credential endpoint Weldall lists for it.
 */
export function gitCredentialAccess({
  issuer,
  open,
}: {
  issuer: () => Promise<string | null>;
  open: OpenRegistry;
}): GitCredentialAccess {
  return {
    issuer,
    async requestCredential({ origin, path, access }: GitCredentialRequest) {
      let client;
      try {
        client = await open((found) => {
          const matches = registriesAtOrigin(found.registries, origin);
          if (matches.length !== 1)
            throw new RegistryAccessError(
              "not_registered",
              matches.length
                ? `Several registries Weldall lists claim ${origin}.`
                : `${origin} is not a registry Weldall lists for you that publishes apps.`,
            );
          const [registry] = matches as [Registry];
          const target = new URL(path.replace(/^\/*/, ""), `${origin}/`).href;
          if (!target.startsWith(registry.git!))
            throw new RegistryAccessError(
              "not_registered",
              `${origin}/${path} is not below the git route of ${describeRegistry(registry)}.`,
            );
          if (!registry.publishAllowed)
            throw new RegistryAccessError(
              "refused",
              `You lack the permission ${registry.publishScope} for publishing apps at ${describeRegistry(registry)}. Ask your Weldall administrator.`,
            );
          return registry;
        }, "changes");
      } catch (error) {
        if (error instanceof RegistryAccessError) throw error;
        throw new RegistryAccessError("refused", errorMessage(error), { cause: error });
      }
      return client.send({
        method: "POST",
        url: client.registry.gitCredentials!,
        body: { path, access },
        timeoutMs: CREDENTIAL_TIMEOUT_MS,
      });
    },
  };
}

export interface DirectCredentialDependencies extends DirectAccessDependencies {
  selectIssuer?: () => Promise<string | null>;
  resolveConfig?: (issuer: string) => Promise<WeldallConfig>;
}

/**
 * The credential helper's direct access: the configured Weldall server and this device's CLI
 * login. It stores no git credential; like every CLI command it may rotate the refresh token in
 * the keychain or fill the configuration cache.
 */
export function directWeldallAccess(
  dependencies: DirectCredentialDependencies = {},
): GitCredentialAccess {
  const select =
    dependencies.selectIssuer ??
    (async () => (await selectIssuer({ allowPrompt: false }))?.issuer ?? null);
  const resolveConfig =
    dependencies.resolveConfig ??
    ((issuer: string) => resolveWeldallConfig({ environmentValue: issuer }));
  let issuer: Promise<string | null> | undefined;
  const configured = async (): Promise<WeldallConfig> => {
    const selected = await (issuer ??= select());
    if (!selected) throw new RegistryAccessError("configuration", "No Weldall issuer is set.");
    try {
      return await resolveConfig(selected);
    } catch (error) {
      // Discovery reports an unreachable server as ConfigurationError caused by the fetch.
      const unreachable =
        !(error instanceof ConfigurationError) ||
        (error.cause instanceof Error && !(error.cause instanceof CliError));
      throw new RegistryAccessError(
        unreachable ? "network" : "configuration",
        unreachable
          ? networkMessage(error instanceof ConfigurationError ? error.cause : error)
          : errorMessage(error),
        { cause: error },
      );
    }
  };
  return gitCredentialAccess({
    issuer: () => (issuer ??= select()),
    open: async (choose, need) =>
      directOpenRegistry(await configured(), dependencies)(choose, need),
  });
}

export type { RegistryAnswer };
