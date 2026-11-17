import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ConnectorError } from "../../errors";
import type { ConnectorProvider, ProviderGrant } from "../../provider";
import {
  GITHUB_APP_CREDENTIAL_KIND,
  parseGitHubAppConfiguration,
  type GitHubAppConfig,
} from "./config";
import { createGitHubAppHost } from "./host";
import { PRIVATE_KEY_INPUT_LIMIT, parseGitHubAppPrivateKey } from "./private-key";

const kind = z.literal(GITHUB_APP_CREDENTIAL_KIND);
export const selectionSchema = z.strictObject({ kind });
export const credentialsSchema = z.strictObject({
  kind,
  /** Canonical PKCS#8 PEM, validated at provisioning. */
  privateKey: z
    .string()
    .min(1)
    .max(PRIVATE_KEY_INPUT_LIMIT)
    .startsWith("-----BEGIN PRIVATE KEY-----"),
});
/** Binds the provisioned key to the App it was uploaded for. */
export const grantSchema = z.strictObject({
  kind,
  apiBaseUrl: z.string(),
  appId: z.string(),
});

function grantFor(config: GitHubAppConfig) {
  const grant = grantSchema.parse({
    kind: GITHUB_APP_CREDENTIAL_KIND,
    apiBaseUrl: config.apiBaseUrl,
    appId: config.appId,
  });
  return grant as ProviderGrant<typeof grant>;
}
const sharedOnly = () =>
  new ConnectorError(
    "unsupported_provider",
    "GitHub App connectors have no personal connections. An administrator provisions the App's private key on a shared connection.",
  );
const serverOperationsOnly = () =>
  new ConnectorError("invalid_target", "Use Git host operations for this connection.");

export const githubAppProvider: ConnectorProvider = {
  type: "github-app",
  serverOnly: true,
  staticConnection: {
    kind: GITHUB_APP_CREDENTIAL_KIND,
    parseCreateInput(value) {
      const { privateKey, ...selection } = selectionSchema
        .extend({ privateKey: z.string().optional() })
        .parse(value);
      return {
        selection,
        credentials:
          privateKey === undefined
            ? null
            : { kind: selection.kind, privateKey: parseGitHubAppPrivateKey(privateKey) },
      };
    },
    parseRotateInput(value) {
      const { privateKey } = z.strictObject({ privateKey: z.string() }).parse(value);
      return { kind: GITHUB_APP_CREDENTIAL_KIND, privateKey: parseGitHubAppPrivateKey(privateKey) };
    },
    buildGrant({ config, selection }) {
      selectionSchema.parse(selection);
      return grantFor(parseGitHubAppConfiguration(config));
    },
  },
  gitHost: {
    open({ config, loadCredentials }) {
      return createGitHubAppHost({
        config: parseGitHubAppConfiguration(config),
        loadPrivateKey: async () => credentialsSchema.parse(await loadCredentials()).privateKey,
      });
    },
  },
  parseConfiguration: parseGitHubAppConfiguration,
  parseSecrets: (value) => z.strictObject({}).parse(value),
  /** A different App or GitHub instance needs a different private key. */
  getConfigurationIdentity: (value) => {
    const config = parseGitHubAppConfiguration(value);
    return `${config.apiBaseUrl}#${config.appId}`;
  },
  describeSetup: () => ({ scopes: [], defaultScopes: [] }),
  describeConnection({ grant }) {
    const app = grantSchema.parse(grant);
    return {
      selectedScopes: [],
      grantedScopes: [],
      scopeLabels: {},
      details: [
        { label: "Credential type", value: "GitHub App private key" },
        { label: "App ID", value: app.appId },
        { label: "GitHub API", value: app.apiBaseUrl },
      ],
      usage: {
        instructions: [
          "Weldall uses this key only on the server, to mint short-lived installation tokens for one repository at a time.",
          "The App's permissions are managed in GitHub. Revoke the key in the App settings on GitHub; deleting it here only stops Weldall from using it.",
        ],
        examples: [],
      },
    };
  },
  validateSetupInput: ({ value }) => selectionSchema.parse(value),
  buildInitialSelection() {
    throw sharedOnly();
  },
  async beginAuthorization() {
    throw sharedOnly();
  },
  async completeAuthorization() {
    throw sharedOnly();
  },
  parseCredentials: (value) => credentialsSchema.parse(value),
  parseGrant: (value) => grantSchema.parse(value) as ProviderGrant<z.infer<typeof grantSchema>>,
  needsRefresh: () => false,
  async refreshCredentials() {
    throw sharedOnly();
  },
  async ensureGrantCurrent({ config, selection, credentials, previousGrant }) {
    credentialsSchema.parse(credentials);
    selectionSchema.parse(selection);
    const current = grantFor(parseGitHubAppConfiguration(config));
    if (!isDeepStrictEqual(grantSchema.parse(previousGrant), { ...current }))
      throw new ConnectorError(
        "grant_mismatch",
        "The provisioned key belongs to a different GitHub App configuration.",
      );
    return current;
  },
  async disconnectGrant() {
    return { status: "unsupported" };
  },
  resolveUpstreamUrl() {
    throw serverOperationsOnly();
  },
  buildUpstreamRequest() {
    throw serverOperationsOnly();
  },
};
