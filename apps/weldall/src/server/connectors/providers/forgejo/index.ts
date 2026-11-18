import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ConnectorError } from "../../errors";
import type { ConnectorProvider, ProviderGrant } from "../../provider";
import {
  FORGEJO_CREDENTIAL_KIND,
  forgejoConfigSchema,
  forgejoRepositoryWebUrl,
  parseForgejoConfiguration,
  type ForgejoConfig,
} from "./config";
import { createForgejoHost } from "./host";

/** Forgejo issues 40 hexadecimal characters; other shapes are accepted within these bounds. */
export const FORGEJO_TOKEN_INPUT_LIMIT = 512;
const token = z
  .string()
  .trim()
  .min(20)
  .max(FORGEJO_TOKEN_INPUT_LIMIT)
  .regex(/^[A-Za-z0-9._~+/=-]+$/, "Paste the access token exactly as Forgejo showed it.");

const kind = z.literal(FORGEJO_CREDENTIAL_KIND);
export const selectionSchema = z.strictObject({ kind });
export const credentialsSchema = z.strictObject({ kind, token });
/** Binds the provisioned token to the instance and the bot user it was entered for. */
export const grantSchema = z.strictObject({
  kind,
  baseUrl: z.string(),
  botUser: z.string(),
});

function grantFor(config: ForgejoConfig) {
  const grant = grantSchema.parse({
    kind: FORGEJO_CREDENTIAL_KIND,
    baseUrl: config.baseUrl,
    botUser: config.botUser.toLowerCase(),
  });
  return grant as ProviderGrant<typeof grant>;
}
function parseToken(value: unknown): string {
  const parsed = token.safeParse(value);
  if (!parsed.success)
    throw new ConnectorError(
      "invalid_token",
      "Paste the bot user's access token exactly as Forgejo showed it when it was created.",
    );
  return parsed.data;
}
const sharedOnly = () =>
  new ConnectorError(
    "unsupported_provider",
    "Forgejo connectors have no personal connections. An administrator provisions the bot user's access token on a shared connection.",
  );
const serverOperationsOnly = () =>
  new ConnectorError("invalid_target", "Use Git host operations for this connection.");

export const forgejoProvider: ConnectorProvider = {
  type: "forgejo",
  serverOnly: true,
  staticConnection: {
    kind: FORGEJO_CREDENTIAL_KIND,
    parseCreateInput(value) {
      const { token: input, ...selection } = selectionSchema
        .extend({ token: z.string().optional() })
        .parse(value);
      return {
        selection,
        credentials:
          input === undefined ? null : { kind: selection.kind, token: parseToken(input) },
      };
    },
    parseRotateInput(value) {
      const { token: input } = z.strictObject({ token: z.string() }).parse(value);
      return { kind: FORGEJO_CREDENTIAL_KIND, token: parseToken(input) };
    },
    buildGrant({ config, selection }) {
      selectionSchema.parse(selection);
      return grantFor(parseForgejoConfiguration(config));
    },
  },
  gitHost: {
    open({ config, loadCredentials }) {
      return createForgejoHost({
        config: parseForgejoConfiguration(config),
        loadToken: async () => credentialsSchema.parse(await loadCredentials()).token,
      });
    },
    repositoryWebUrl: ({ config, repository }) =>
      forgejoRepositoryWebUrl(forgejoConfigSchema.parse(config), repository),
  },
  parseConfiguration: parseForgejoConfiguration,
  parseSecrets: (value) => z.strictObject({}).parse(value),
  /** A different instance or bot user needs a different token. */
  getConfigurationIdentity: (value) => {
    const config = parseForgejoConfiguration(value);
    return `${config.baseUrl}#${config.botUser.toLowerCase()}`;
  },
  describeSetup: () => ({ scopes: [], defaultScopes: [] }),
  describeConnection({ grant }) {
    const bot = grantSchema.parse(grant);
    return {
      selectedScopes: [],
      grantedScopes: [],
      scopeLabels: {},
      details: [
        { label: "Credential type", value: "Forgejo bot user access token" },
        { label: "Bot user", value: bot.botUser },
        { label: "Forgejo", value: bot.baseUrl },
      ],
      usage: {
        instructions: [
          "Weldall uses this token only on the server: for creating repositories, the git proxy, pull requests and status reads. It never reaches a device.",
          "The token does not expire and reaches every repository the bot user can access. Revoke it in Forgejo (the bot user's Settings > Applications); deleting it here only stops Weldall from using it.",
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
    const current = grantFor(parseForgejoConfiguration(config));
    if (!isDeepStrictEqual(grantSchema.parse(previousGrant), { ...current }))
      throw new ConnectorError(
        "grant_mismatch",
        "The provisioned token belongs to a different Forgejo instance or bot user.",
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
