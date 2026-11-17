import { createDpopProof } from "@weldall/sdk";
import { resolveWeldallConfig, selectIssuer, type WeldallConfig } from "../config.js";
import { CliError, ConfigurationError, errorMessage } from "../errors.js";
import { responseValue } from "../http.js";
import { SessionManager, type AccessSession } from "../services/session-manager.js";
import {
  GitCredentialFailure,
  type GitCredentialRequest,
  type WeldallAnswer,
  type WeldallGitCredentialAccess,
} from "./credential-helper.js";

const REQUEST_TIMEOUT_MS = 30_000;

/** `fetch failed` alone says little; the cause names the refused connection or DNS failure. */
const networkMessage = (error: unknown) => {
  const cause = error instanceof Error ? error.cause : undefined;
  const reason = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  return `${errorMessage(error)}${reason}`;
};

export interface DirectAccessDependencies {
  selectIssuer?: () => Promise<string | null>;
  resolveConfig?: (issuer: string) => Promise<WeldallConfig>;
  getSession?: (config: WeldallConfig, signal: AbortSignal) => Promise<AccessSession>;
  fetch?: typeof fetch;
}

/**
 * Reaches Weldall directly with this device's CLI login (`POST /api/me/git-credentials`, DPoP).
 * It stores no git credential; like every CLI command it may rotate the refresh token in the
 * keychain or fill the configuration cache.
 */
export function directWeldallAccess(
  dependencies: DirectAccessDependencies = {},
): WeldallGitCredentialAccess {
  const select =
    dependencies.selectIssuer ??
    (async () => (await selectIssuer({ allowPrompt: false }))?.issuer ?? null);
  const resolveConfig =
    dependencies.resolveConfig ??
    ((issuer: string) => resolveWeldallConfig({ environmentValue: issuer }));
  const getSession =
    dependencies.getSession ??
    ((config: WeldallConfig, signal: AbortSignal) =>
      new SessionManager(config).getAccessSession(signal));
  const fetcher = dependencies.fetch ?? fetch;
  let issuer: Promise<string | null> | undefined;

  return {
    issuer: () => (issuer ??= select()),
    async requestCredential(request: GitCredentialRequest): Promise<WeldallAnswer> {
      const selected = await (issuer ??= select());
      if (!selected) throw new GitCredentialFailure("configuration", "No Weldall issuer is set.");
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

      let config: WeldallConfig;
      try {
        config = await resolveConfig(selected);
      } catch (error) {
        // Discovery reports an unreachable server as ConfigurationError caused by the fetch.
        const unreachable =
          !(error instanceof ConfigurationError) ||
          (error.cause instanceof Error && !(error.cause instanceof CliError));
        throw new GitCredentialFailure(
          unreachable ? "network" : "configuration",
          unreachable
            ? networkMessage(error instanceof ConfigurationError ? error.cause : error)
            : errorMessage(error),
          { cause: error },
        );
      }

      let session: AccessSession;
      try {
        session = await getSession(config, signal);
      } catch (error) {
        // The session layer reports a missing login, a rejected refresh, or an unreadable
        // store as CliError; anything else is the transport failing.
        throw new GitCredentialFailure(
          error instanceof CliError ? "login" : "network",
          error instanceof CliError ? errorMessage(error) : networkMessage(error),
          { cause: error },
        );
      }

      const url = `${config.issuer}/api/me/git-credentials`;
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `DPoP ${session.accessToken}`,
            dpop: await createDpopProof({
              ...session.credentials,
              method: "POST",
              url,
              accessToken: session.accessToken,
            }),
            "content-type": "application/json",
          },
          body: JSON.stringify({ path: request.path, access: request.access }),
          redirect: "error",
          signal,
        });
        return { status: response.status, body: await responseValue(response) };
      } catch (error) {
        throw new GitCredentialFailure("network", networkMessage(error), { cause: error });
      }
    },
  };
}
