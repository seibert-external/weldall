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

import {
  staticConnection,
  serviceCredentialsSchema,
  serviceSelectionSchema,
  serviceGrantSchema,
} from "./static";
const allCredentials = z.discriminatedUnion("kind", [credentialsSchema, serviceCredentialsSchema]);
const allGrants = z.discriminatedUnion("kind", [grantSchema, serviceGrantSchema]);
export const atlassianMcpProvider: ConnectorProvider = {
  type: "atlassian-mcp",
  staticConnection,
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
    const approved = allGrants.parse(grant);
    if (approved.kind === "service-account-api-key") {
      const selected = serviceSelectionSchema.parse(selection);
      return {
        selectedScopes: [],
        grantedScopes: [],
        scopeLabels: Object.fromEntries(scopeCatalog.map((scope) => [scope, scope])),
        details: [
          { label: "Credential type", value: "Atlassian service account API key" },
          { label: "Configured cloud IDs", value: selected.cloudIds.join(", ") || "None" },
        ],
        usage: {
          instructions: [
            "Token permissions are managed in Atlassian and are not inspected by Weldall.",
            "Some tools require OAuth. API-key calls may require explicit cloudId arguments.",
            "Revoke this API key in Atlassian administration; Weldall cannot revoke it upstream.",
          ],
          examples: [],
        },
      };
    }
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
  validateSetupInput: ({ config, value }) =>
    serviceSelectionSchema.safeParse(value).success
      ? serviceSelectionSchema.parse(value)
      : validateSelection(config, value),
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
  parseCredentials: (value) => allCredentials.parse(value),
  parseGrant: (value) => allGrants.parse(value) as ProviderGrant<z.infer<typeof allGrants>>,
  needsRefresh: (value) => {
    const parsed = allCredentials.parse(value);
    return parsed.kind === "oauth" && parsed.expiresAt <= Date.now() + 60_000;
  },
  async refreshCredentials({ config, selection, credentials }) {
    const result = await exchangeAtlassianMcpTokens({
      scopes: validateSelection(config, selection).scopes,
      previous: credentials,
    });
    return { ...result, grant: result.grant as ProviderGrant<typeof result.grant> };
  },
  async ensureGrantCurrent({ config, selection, credentials, previousGrant }) {
    if (allCredentials.parse(credentials).kind === "service-account-api-key") {
      const selected = serviceSelectionSchema.parse(selection);
      const grant = serviceGrantSchema.parse(previousGrant);
      if (
        JSON.stringify(selected) !==
        JSON.stringify({
          kind: grant.kind,
          cloudIds: grant.cloudIds,
        })
      )
        throw new ConnectorError("grant_mismatch", "MCP grant no longer matches the connection.");
      return grant as ProviderGrant<typeof grant>;
    }
    const selected = validateSelection(config, selection);
    const current = grantFromCredentials(credentials);
    if (
      current.scopes.some((scope) => !selected.scopes.includes(scope)) ||
      JSON.stringify(current) !== JSON.stringify(grantSchema.parse(previousGrant))
    )
      throw new ConnectorError("grant_mismatch", "MCP grant no longer matches the connection.");
    return current as ProviderGrant<typeof current>;
  },
  async disconnectGrant({ credentials }) {
    return {
      status: "unsupported",
      remediationUrl:
        allCredentials.parse(credentials).kind === "service-account-api-key"
          ? "https://admin.atlassian.com"
          : "https://id.atlassian.com/manage-profile/apps",
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
      const parsed = allCredentials.parse(credentials);
      output.set(
        "authorization",
        `Bearer ${parsed.kind === "oauth" ? parsed.accessToken : parsed.apiKey}`,
      );
      return {
        method,
        headers: output,
        ...(body === undefined ? {} : { body }),
        signal,
        redirect: "error",
      };
    },
    assertSafeResult(value, credentials) {
      const tokens = allCredentials.parse(credentials);
      const secrets =
        tokens.kind === "oauth" ? [tokens.accessToken, tokens.refreshToken] : [tokens.apiKey];
      const output = JSON.stringify(value);
      if (secrets.some((secret) => output.includes(JSON.stringify(secret).slice(1, -1))))
        throw new McpBoundaryError("upstream_protocol_error");
    },
  },
};
