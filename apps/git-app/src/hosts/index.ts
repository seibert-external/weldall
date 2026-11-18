import { GitAppError } from "../errors.js";
import type { GitHost, GitRepositoryRef } from "./git-host.js";
import {
  deriveWebBaseUrl,
  parseGitHubAppConfiguration,
  type GitHubAppConfig,
} from "./github/config.js";
import { createGitHubAppHost } from "./github/host.js";
import { parseGitHubAppPrivateKey } from "./github/private-key.js";
import type { InstallationTokenCache } from "./github/tokens.js";
import {
  forgejoRepositoryWebUrl,
  parseForgejoConfiguration,
  type ForgejoConfig,
} from "./forgejo/config.js";
import { createForgejoHost } from "./forgejo/host.js";
import { parseForgejoToken } from "./forgejo/token.js";

/** The Git host a Git app instance serves; each instance is configured for exactly one. */
export const HOST_KINDS = ["github", "forgejo"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

/** The validated host configuration (the former connector `providerConfig`). */
export type HostConfiguration =
  { kind: "github"; config: GitHubAppConfig } | { kind: "forgejo"; config: ForgejoConfig };

/**
 * Parses the host configuration with the same schema the connector used. Throws a `ZodError` or
 * a {@link GitAppError} that names the problem; neither contains a secret, because the host
 * configuration holds none.
 */
export function parseHostConfiguration(kind: HostKind, value: unknown): HostConfiguration {
  return kind === "github"
    ? { kind, config: parseGitHubAppConfiguration(value) }
    : { kind, config: parseForgejoConfiguration(value) };
}

/**
 * Validates the host secret: the GitHub App's private key (PEM, returned as canonical PKCS#8)
 * or the Forgejo bot user's access token. Errors carry fixed messages and never the input.
 */
export function parseHostSecret(kind: HostKind, value: string): string {
  return kind === "github" ? parseGitHubAppPrivateKey(value) : parseForgejoToken(value);
}

/** The opened host plus what the Git app needs from its configuration without a host call. */
export interface ConfiguredHost {
  kind: HostKind;
  host: GitHost;
  /** Organisation that owns the apps' repositories. */
  organization: string;
  /** Template names an app can start from. */
  templates: string[];
  /** Browser URL of a repository from configuration alone; null when unknown. */
  repositoryWebUrl(repository: GitRepositoryRef): string | null;
}

/**
 * Opens the instance's one Git host. The secret stays in this process: it is handed to the driver
 * as a loader and never returned or logged.
 */
export function openConfiguredHost({
  configuration,
  secret,
  timing,
  tokens,
}: {
  configuration: HostConfiguration;
  secret: string;
  /** Overrides the wait for a new repository's default branch (tests). */
  timing?: { readyTimeoutMs: number; pollIntervalMs: number };
  /** GitHub only: a separate installation token cache (tests). */
  tokens?: InstallationTokenCache;
}): ConfiguredHost {
  const templates = configuration.config.templates.map(({ name }) => name);
  if (configuration.kind === "github") {
    const { config } = configuration;
    const webBaseUrl = deriveWebBaseUrl(config.apiBaseUrl);
    return {
      kind: "github",
      host: createGitHubAppHost({
        config,
        loadPrivateKey: async () => secret,
        ...(tokens ? { tokens } : {}),
        ...(timing ? { timing } : {}),
      }),
      organization: config.organization,
      templates,
      repositoryWebUrl: (repository) =>
        webBaseUrl
          ? `${webBaseUrl}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
          : null,
    };
  }
  if (configuration.kind === "forgejo") {
    const { config } = configuration;
    return {
      kind: "forgejo",
      host: createForgejoHost({
        config,
        loadToken: async () => secret,
        ...(timing ? { timing } : {}),
      }),
      organization: config.organization,
      templates,
      repositoryWebUrl: (repository) => forgejoRepositoryWebUrl(config, repository),
    };
  }
  throw new GitAppError("unsupported_host", "Unknown Git host.", 500);
}
