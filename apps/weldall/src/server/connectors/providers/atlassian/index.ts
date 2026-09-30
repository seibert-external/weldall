import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ConnectorError, RejectedProviderCredentials } from "../../errors";
import type { ConnectorProvider } from "../../provider";
import {
  atlassianConfigSchema,
  atlassianSecretsSchema,
  canonicalScopes,
  requiredScopes,
  scopeCatalog,
  selectionSchema,
  validateSelection,
} from "./config";
import { credentialsSchema, exchangeToken, getAtlassianJson, getResources } from "./oauth";
import { parseGrant, resolveUpstream, validateResources } from "./grant";
import { describeAtlassianUsage } from "./usage";

export const atlassianProvider = {
  type: "atlassian",
  parseConfiguration: (value) => atlassianConfigSchema.parse(value),
  parseSecrets: (value) => atlassianSecretsSchema.parse(value),
  getConfigurationIdentity: (value) => atlassianConfigSchema.parse(value).clientId,
  describeSetup({ config, previousSelection }) {
    const policy = atlassianConfigSchema.parse(config);
    return {
      scopes: [
        ...requiredScopes.map((id) => ({
          id,
          label:
            id === "offline_access"
              ? "Keep access while offline"
              : "Identify your Atlassian account",
          description: "Required for this connection.",
          group: "Account",
          required: true,
        })),
        ...scopeCatalog
          .filter((scope) => policy.allowedScopes.includes(scope.id))
          .map((scope) => ({
            id: scope.id,
            label: scope.label,
            description: `${scope.description} (${scope.id})`,
            group: `${scope.product === "jira" ? "Jira Cloud" : "Confluence Cloud"} · ${scope.mode === "classic" ? "Classic" : "Granular"}`,
            required: false,
          })),
      ],
      defaultScopes: policy.defaultScopes,
      ...(previousSelection === undefined
        ? {}
        : { selection: selectionSchema.parse(previousSelection) }),
    };
  },
  describeConnection({ selection, grant }) {
    const selected = selectionSchema.parse(selection);
    const approved = parseGrant(grant);
    const displayedScopes = new Set([...selected.scopes, ...approved.scopes]);
    return {
      selectedScopes: selected.scopes,
      grantedScopes: approved.scopes,
      usage: describeAtlassianUsage(approved),
      scopeLabels: Object.fromEntries(
        scopeCatalog
          .filter((scope) => displayedScopes.has(scope.id))
          .map((scope) => [scope.id, scope.label]),
      ),
      details: [
        { label: "Site", value: `${approved.siteName} (${approved.cloudId})` },
        { label: "Site URL", value: approved.siteUrl },
      ],
    };
  },
  buildInitialSelection({ config, previousSelection }) {
    const policy = atlassianConfigSchema.parse(config);
    const prior =
      previousSelection === undefined ? undefined : selectionSchema.parse(previousSelection);
    return {
      scopes: canonicalScopes([
        ...requiredScopes,
        ...(prior
          ? prior.scopes.filter((scope) => policy.allowedScopes.includes(scope))
          : policy.defaultScopes),
      ]),
    };
  },
  validateSetupInput: ({ config, value }) => validateSelection(config, value),
  async beginAuthorization({ config, secrets, selection, callbackUrl }) {
    const policy = atlassianConfigSchema.parse(config);
    atlassianSecretsSchema.parse(secrets);
    const selected = validateSelection(policy, selection);
    const state = randomBytes(32).toString("base64url");
    const url = new URL("https://auth.atlassian.com/authorize");
    url.search = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: policy.clientId,
      scope: selected.scopes.join(" "),
      redirect_uri: callbackUrl,
      state,
      response_type: "code",
      prompt: "consent",
    }).toString();
    return { state, url: url.toString(), attempt: {} };
  },
  async completeAuthorization({ config, secrets, selection, callback, callbackUrl }) {
    const policy = atlassianConfigSchema.parse(config);
    const selected = validateSelection(policy, selection);
    const credentials = await exchangeToken(
      {
        grant_type: "authorization_code",
        code: z.string().min(1).parse(callback.get("code")),
        redirect_uri: callbackUrl,
        client_id: policy.clientId,
        client_secret: atlassianSecretsSchema.parse(secrets).clientSecret,
      },
      selected.scopes,
    );
    try {
      const identity = z
        .object({ account_id: z.string().min(1).max(500), name: z.string().min(1).max(500) })
        .parse(await getAtlassianJson("/me", credentials.accessToken));
      const grant = validateResources({
        config: policy,
        selection,
        credentials,
        resources: await getResources(credentials.accessToken),
      });
      return { accountId: identity.account_id, accountName: identity.name, credentials, grant };
    } catch {
      throw new RejectedProviderCredentials({ credentials });
    }
  },
  parseCredentials: (value) => credentialsSchema.parse(value),
  parseGrant,
  needsRefresh: (value) => credentialsSchema.parse(value).expiresAt <= Date.now() + 60_000,
  async refreshCredentials({ config, secrets, selection, credentials, previousGrant }) {
    const policy = atlassianConfigSchema.parse(config);
    validateSelection(policy, selection);
    const previous = credentialsSchema.parse(credentials);
    const next = await exchangeToken(
      {
        grant_type: "refresh_token",
        refresh_token: previous.refreshToken,
        client_id: policy.clientId,
        client_secret: atlassianSecretsSchema.parse(secrets).clientSecret,
      },
      previous.grantedScopes,
    );
    try {
      return {
        credentials: next,
        grant: validateResources({
          config,
          selection,
          credentials: next,
          resources: await getResources(next.accessToken),
          expectedCloudId: parseGrant(previousGrant).cloudId,
        }),
      };
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "provider_unavailable")
        return { credentials: next, grant: parseGrant(previousGrant) };
      throw new RejectedProviderCredentials({ credentials: next });
    }
  },
  async ensureGrantCurrent({ config, selection, credentials, previousGrant }) {
    const tokens = credentialsSchema.parse(credentials);
    return validateResources({
      config,
      selection,
      credentials: tokens,
      resources: await getResources(tokens.accessToken),
      expectedCloudId: parseGrant(previousGrant).cloudId,
    });
  },
  // No assumed undocumented revocation endpoint or app-wide revocation that could affect other sites.
  async disconnectGrant() {
    return {
      status: "unsupported",
      remediationUrl: "https://id.atlassian.com/manage-profile/apps",
    };
  },
  resolveUpstreamUrl: resolveUpstream,
  buildUpstreamRequest({ credentials, request, signal }) {
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()])
      if (name.startsWith("x-atlassian-") || name === "x-http-method-override")
        headers.delete(name);
    headers.set("authorization", `Bearer ${credentialsSchema.parse(credentials).accessToken}`);
    return {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: Buffer.from(request.body) }),
      redirect: "error",
      signal,
    };
  },
} satisfies ConnectorProvider;
