import type { ResourceRegistryEntry } from "@weldall/sdk";
import { resolveWeldallConfig, selectIssuer, type WeldallConfig } from "../config.js";
import { CliError, ConfigurationError, errorMessage } from "../errors.js";
import { responseValue } from "../http.js";
import { connectResource } from "../services/resources.js";
import { SessionManager, type AccessSession } from "../services/session-manager.js";
import type { GitCredentialAccess, GitCredentialRequest } from "./credential-helper.js";
import {
  GIT_APP_SCOPES,
  GitAppAccessError,
  gitAppsAtOrigin,
  type GitApp,
  type GitAppAnswer,
  type OpenGitApp,
} from "./git-apps.js";

/**
 * How the CLI reaches Weldall and the Git apps: the swappable seam between the protocol and
 * publish code and the person's login. The direct variants here use this device's CLI login
 * (keychain session, DPoP). Under a client's sandbox, the git credential helper runs inside the
 * sandbox and gets a {@link GitCredentialAccess} through the sandbox door (INV-133) instead; the
 * door runs outside with the person's session and must keep the checks of
 * {@link gitCredentialAccess}: look the origin up in Weldall's resource registry and answer only
 * for a registered Git app's `/git/` route.
 */

const SETUP_TIMEOUT_MS = 30_000;
const CREDENTIAL_TIMEOUT_MS = 30_000;

/** `fetch failed` alone says little; the cause names the refused connection or DNS failure. */
const networkMessage = (error: unknown) => {
  const cause = error instanceof Error ? error.cause : undefined;
  const reason = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  return `${errorMessage(error)}${reason}`;
};

export interface DirectAccessDependencies {
  getSession?: (config: WeldallConfig, signal: AbortSignal) => Promise<AccessSession>;
}

/**
 * Opens Git app clients with this device's CLI login: one registry read, the token exchange at
 * Weldall and the downstream token at the Git app, all bounded by 30 s; each later request has
 * its own timeout. A missing login or an unreachable server is a {@link GitAppAccessError};
 * what `choose` throws is passed on unchanged.
 */
export function directOpenGitApp(
  config: WeldallConfig,
  dependencies: DirectAccessDependencies = {},
): OpenGitApp {
  const getSession =
    dependencies.getSession ??
    ((current: WeldallConfig, signal: AbortSignal) =>
      new SessionManager(current).getAccessSession(signal));
  return async (choose, scope) => {
    const setupSignal = AbortSignal.timeout(SETUP_TIMEOUT_MS);
    let session: AccessSession;
    try {
      session = await getSession(config, setupSignal);
    } catch (error) {
      // The session layer reports a missing login, a rejected refresh, or an unreadable store as
      // CliError; anything else is the transport failing.
      throw error instanceof CliError
        ? new GitAppAccessError("login", errorMessage(error), {
            cause: error,
            hint: "Run `weldall login`, then try again.",
          })
        : new GitAppAccessError("network", networkMessage(error), { cause: error });
    }
    let chosen: GitApp | undefined;
    let client;
    try {
      client = await connectResource(
        config,
        session,
        (resources: ResourceRegistryEntry[]) => (chosen = choose(resources)).resource,
        [scope],
        { setupSignal },
      );
    } catch (error) {
      if (chosen === undefined && error instanceof CliError) throw error;
      if (error instanceof GitAppAccessError) throw error;
      throw error instanceof CliError
        ? new GitAppAccessError("refused", errorMessage(error), {
            cause: error,
            ...(error.hint ? { hint: error.hint } : {}),
          })
        : new GitAppAccessError("network", networkMessage(error), { cause: error });
    }
    const gitApp = chosen!;
    return {
      gitApp,
      async send({ method, path, body, timeoutMs }) {
        let response: Response;
        try {
          response = await client.send({
            url: `${gitApp.origin}/api/${path}`,
            method,
            ...(body === undefined ? {} : { json: body }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new GitAppAccessError("network", networkMessage(error), { cause: error });
        }
        return { status: response.status, body: await responseValue(response) };
      },
    };
  };
}

/**
 * The git credential helper's access over any {@link OpenGitApp}: answers only when `origin` is
 * the origin of exactly one Git app Weldall lists for this person, and asks that Git app for a
 * credential for `path` (`POST <origin>/api/git-credentials`).
 */
export function gitCredentialAccess({
  issuer,
  open,
}: {
  issuer: () => Promise<string | null>;
  open: OpenGitApp;
}): GitCredentialAccess {
  return {
    issuer,
    async requestCredential({ origin, path, access }: GitCredentialRequest) {
      let client;
      try {
        client = await open((resources) => {
          const matches = gitAppsAtOrigin(resources, origin);
          if (matches.length !== 1)
            throw new GitAppAccessError(
              "not_registered",
              matches.length
                ? `Several resources registered in Weldall claim ${origin}.`
                : `${origin} is not a Git app registered in Weldall for you.`,
            );
          const [gitApp] = matches as [GitApp];
          if (!gitApp.resource.grantedScopes.includes(GIT_APP_SCOPES.publish))
            throw new GitAppAccessError(
              "refused",
              `You lack the permission ${GIT_APP_SCOPES.publish} for the Git app ${gitApp.name}. Ask your Weldall administrator.`,
            );
          return gitApp;
        }, GIT_APP_SCOPES.publish);
      } catch (error) {
        if (error instanceof GitAppAccessError) throw error;
        throw new GitAppAccessError("refused", errorMessage(error), { cause: error });
      }
      return client.send({
        method: "POST",
        path: "git-credentials",
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
    if (!selected) throw new GitAppAccessError("configuration", "No Weldall issuer is set.");
    try {
      return await resolveConfig(selected);
    } catch (error) {
      // Discovery reports an unreachable server as ConfigurationError caused by the fetch.
      const unreachable =
        !(error instanceof ConfigurationError) ||
        (error.cause instanceof Error && !(error.cause instanceof CliError));
      throw new GitAppAccessError(
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
    open: async (choose, scope) =>
      directOpenGitApp(await configured(), dependencies)(choose, scope),
  });
}

export type { GitAppAnswer };
