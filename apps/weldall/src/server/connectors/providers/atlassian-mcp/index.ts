import { z } from "zod";
import { McpBoundaryError } from "@weldall/sdk/mcp";
import { ConnectorError } from "../../errors";
import type { ConnectorProvider, ProviderGrant } from "../../provider";
import {
  atlassianMcpConfigSchema,
  canonicalScopes,
  requiredScopes,
  scopeCatalog,
  selectionSchema,
  validateSelection,
  validateMcpEndpoint,
  ATLASSIAN_MCP,
} from "./config";
import {
  beginAtlassianMcpAuthorization,
  credentialsSchema,
  exchangeAtlassianMcpTokens,
  grantFromCredentials,
  grantSchema,
  registerAtlassianMcpClient,
  registrationBinding,
} from "./oauth";

export const atlassianMcpProvider: ConnectorProvider = {
  type: "atlassian-mcp",
  registration: {
    binding: ({ callbackUrl }) => registrationBinding(callbackUrl),
    register: ({ callbackUrl }) => registerAtlassianMcpClient(callbackUrl),
  },
  parseConfiguration: (value) => atlassianMcpConfigSchema.parse(value),
  parseSecrets: (value) => z.strictObject({}).parse(value),
  getConfigurationIdentity: () => ATLASSIAN_MCP.resource,
  describeSetup({ config, previousSelection }) {
    const policy = atlassianMcpConfigSchema.parse(config);
    return {
      scopes: [
        ...requiredScopes,
        ...scopeCatalog.filter((s) => policy.allowedScopes.includes(s)),
      ].map((id) => ({
        id,
        label: id,
        description: requiredScopes.includes(id)
          ? "Required for personal MCP authorization and refresh."
          : "Atlassian MCP permission.",
        group: requiredScopes.includes(id)
          ? "Account"
          : id.includes(":jira:")
            ? "Jira MCP"
            : "Confluence MCP",
        required: requiredScopes.includes(id),
      })),
      defaultScopes: policy.defaultScopes,
      ...(previousSelection === undefined
        ? {}
        : { selection: selectionSchema.parse(previousSelection) }),
    };
  },
  describeConnection({ selection, grant }) {
    const approved = grantSchema.parse(grant);
    return {
      selectedScopes: selectionSchema.parse(selection).scopes,
      grantedScopes: approved.scopes,
      scopeLabels: Object.fromEntries([...requiredScopes, ...scopeCatalog].map((s) => [s, s])),
      details: [{ label: "MCP site", value: approved.cloudId }],
      usage: {
        instructions: [
          "Use this connection with weldall mcp commands, not REST requests.",
          "The upstream token is site-bound and uses an Atlassian system-account identity.",
        ],
        examples: [],
      },
    };
  },
  buildInitialSelection({ config, previousSelection }) {
    const policy = atlassianMcpConfigSchema.parse(config);
    const prior =
      previousSelection === undefined ? undefined : selectionSchema.parse(previousSelection);
    return {
      scopes: canonicalScopes([
        ...requiredScopes,
        ...(prior
          ? prior.scopes.filter((s) => policy.allowedScopes.some((allowed) => allowed === s))
          : policy.defaultScopes),
      ]),
    };
  },
  validateSetupInput: ({ config, value }) => validateSelection(config, value),
  async beginAuthorization({ config, selection, callbackUrl, registration }) {
    if (!registration)
      throw new ConnectorError(
        "registration_required",
        "MCP client registration is unavailable.",
        503,
      );
    return beginAtlassianMcpAuthorization({
      clientId: registration.clientId,
      callbackUrl,
      scopes: validateSelection(config, selection).scopes,
    });
  },
  async completeAuthorization({ config, selection, callback, callbackUrl, attempt }) {
    const result = await exchangeAtlassianMcpTokens({
      scopes: validateSelection(config, selection).scopes,
      code: callback.get("code") ?? "",
      callbackUrl,
      attempt,
    });
    return {
      ...result,
      grant: result.grant as ProviderGrant<typeof result.grant>,
      accountId: result.grant.accountId,
      accountName: `Atlassian MCP · ${result.grant.cloudId}`,
    };
  },
  parseCredentials: (value) => credentialsSchema.parse(value),
  parseGrant: (value) => grantSchema.parse(value) as ProviderGrant<z.infer<typeof grantSchema>>,
  needsRefresh: (value) => credentialsSchema.parse(value).expiresAt <= Date.now() + 60_000,
  async refreshCredentials({ config, selection, credentials }) {
    const result = await exchangeAtlassianMcpTokens({
      scopes: validateSelection(config, selection).scopes,
      previous: credentials,
    });
    return { ...result, grant: result.grant as ProviderGrant<typeof result.grant> };
  },
  async ensureGrantCurrent({ config, selection, credentials, previousGrant }) {
    const selected = validateSelection(config, selection);
    const current = grantFromCredentials(credentials);
    if (
      current.scopes.some((scope) => !selected.scopes.includes(scope)) ||
      JSON.stringify(current) !== JSON.stringify(grantSchema.parse(previousGrant))
    )
      throw new ConnectorError("grant_mismatch", "MCP grant no longer matches the connection.");
    return current as ProviderGrant<typeof current>;
  },
  async disconnectGrant() {
    return {
      status: "unsupported",
      remediationUrl: "https://id.atlassian.com/manage-profile/apps",
    };
  },
  resolveUpstreamUrl() {
    throw new ConnectorError("invalid_target", "Use MCP operations for this connection.");
  },
  buildUpstreamRequest() {
    throw new ConnectorError("invalid_target", "Use MCP operations for this connection.");
  },
  mcp: {
    getEndpoint: () => new URL(ATLASSIAN_MCP.resource),
    validateEndpoint: ({ endpoint }) => validateMcpEndpoint(endpoint),
    buildAuthenticatedRequest({ endpoint, credentials, method, headers, body, signal }) {
      validateMcpEndpoint(endpoint);
      const output = new Headers(headers);
      output.set("authorization", `Bearer ${credentialsSchema.parse(credentials).accessToken}`);
      return {
        method,
        headers: output,
        ...(body === undefined ? {} : { body }),
        signal,
        redirect: "error",
      };
    },
    assertSafeResult(value, credentials) {
      const tokens = credentialsSchema.parse(credentials);
      const output = JSON.stringify(value);
      if (
        [tokens.accessToken, tokens.refreshToken].some((secret) =>
          output.includes(JSON.stringify(secret).slice(1, -1)),
        )
      )
        throw new McpBoundaryError("upstream_protocol_error");
    },
  },
};
