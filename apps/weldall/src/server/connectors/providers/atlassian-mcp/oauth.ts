import { randomBytes, createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { z } from "zod";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidGrantError,
  InvalidClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { assertMcpJson } from "@weldall/sdk/mcp";
import { createPinnedFetch } from "../../core/secure-fetch";
import { logger } from "../../../observability/logger";
import { ConnectorError, ProviderTokenError, RejectedProviderCredentials } from "../../errors";
import { ATLASSIAN_MCP as target, canonicalScopes } from "./config";

const token = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[\x21-\x7e]+$/);
export const credentialsSchema = z.strictObject({
  accessToken: token,
  refreshToken: token,
  expiresAt: z.number().finite(),
  clientId: z.string().min(1).max(2048),
  grantedScopes: z.array(z.string()).max(40),
});
export const grantSchema = z.strictObject({
  resource: z.literal(target.resource),
  accountId: z.string().min(1).max(500),
  cloudId: z.string().uuid(),
  scopes: z.array(z.string()).max(40),
});
const attemptSchema = z.strictObject({
  clientId: z.string().min(1).max(2048),
  codeVerifier: z.string().min(43).max(128),
  callbackUrl: z.string().url(),
});

/** Exact provider-owned endpoints. No caller-supplied discovery/registration or token URL. */
export function createAtlassianOAuthFetch(): FetchLike {
  return createPinnedFetch({
    maximumBytes: 128 * 1024,
    signal: AbortSignal.timeout(20_000),
    validateUrl(url, method) {
      const expected = [target.resourceMetadata, target.metadata].some(
        (endpoint) => endpoint === url.href,
      )
        ? "GET"
        : [target.token, target.registration].some((endpoint) => endpoint === url.href)
          ? "POST"
          : null;
      if (method !== expected)
        throw new ConnectorError("provider_unavailable", "Unsupported OAuth endpoint.", 502);
    },
  });
}

async function discover(fetchFn: FetchLike, scopes: string[]) {
  const resource = await discoverOAuthProtectedResourceMetadata(
    target.resource,
    { resourceMetadataUrl: new URL(target.resourceMetadata) },
    fetchFn,
  );
  const metadata = await discoverAuthorizationServerMetadata(target.issuer, { fetchFn });
  if (
    !metadata ||
    resource.resource !== target.resource ||
    resource.authorization_servers?.length !== 1 ||
    resource.authorization_servers[0] !== target.issuer ||
    scopes.some((s) => !resource.scopes_supported?.includes(s)) ||
    metadata.issuer !== target.issuer ||
    metadata.authorization_endpoint !== target.authorization ||
    metadata.token_endpoint !== target.token ||
    metadata.registration_endpoint !== target.registration ||
    !metadata.code_challenge_methods_supported?.includes("S256") ||
    !metadata.token_endpoint_auth_methods_supported?.includes("none")
  )
    throw new ConnectorError(
      "provider_unavailable",
      "Atlassian MCP OAuth metadata does not match the reviewed profile.",
      502,
    );
  return metadata;
}
const client = (clientId: string) => ({
  client_id: clientId,
  token_endpoint_auth_method: "none" as const,
  redirect_uris: [] as string[],
});

export async function registerAtlassianMcpClient(
  callbackUrl: string,
  fetchFn = createAtlassianOAuthFetch(),
) {
  try {
    const metadata = await discover(fetchFn, []);
    const value = await registerClient(target.issuer, {
      metadata,
      fetchFn,
      clientMetadata: {
        client_name: "Weldall Atlassian MCP",
        redirect_uris: [callbackUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    if (
      value.token_endpoint_auth_method !== "none" ||
      !value.client_id ||
      value.client_id.length > 2048 ||
      value.redirect_uris.length !== 1 ||
      value.redirect_uris[0] !== callbackUrl
    )
      throw new Error();
    // Atlassian may return an unused client_secret for a public client. Do not retain it.
    return { clientId: value.client_id };
  } catch {
    throw new ConnectorError(
      "registration_failed",
      "MCP client registration failed. An administrator must review its state before retrying.",
      503,
    );
  }
}
export const registrationBinding = (callbackUrl: string) =>
  createHash("sha256")
    .update(`${target.issuer}\n${target.resource}\n${callbackUrl}\nnone`)
    .digest("hex");

export async function beginAtlassianMcpAuthorization(
  input: { clientId: string; callbackUrl: string; scopes: string[] },
  fetchFn = createAtlassianOAuthFetch(),
) {
  try {
    const metadata = await discover(fetchFn, input.scopes);
    const state = randomBytes(32).toString("base64url");
    const { authorizationUrl, codeVerifier } = await startAuthorization(target.issuer, {
      metadata,
      clientInformation: client(input.clientId),
      redirectUrl: input.callbackUrl,
      scope: input.scopes.join(" "),
      state,
      resource: new URL(target.resource),
    });
    return {
      state,
      url: authorizationUrl.href,
      attempt: { clientId: input.clientId, codeVerifier, callbackUrl: input.callbackUrl },
    };
  } catch {
    throw new ConnectorError(
      "provider_unavailable",
      "Could not start Atlassian MCP authorization.",
      502,
    );
  }
}

/** Claims are read only from tokens obtained directly from the pinned TLS token endpoint (or
 * its authenticated envelope). Never use this decoder to accept a caller-provided bearer token.
 * The system-account subject is not assumed to be the human Weldall identity.
 */
export function grantFromCredentials(value: unknown) {
  const credentials = credentialsSchema.parse(value);
  const claims = decodeJwt(credentials.accessToken);
  assertMcpJson(claims, 65536);
  const accountId = z.string().min(1).max(500).parse(claims.sub);
  const sites = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^ari:cloud:[a-z0-9-]+::site\/([0-9a-f-]{36})$/i.exec(value);
      if (match) sites.add(z.string().uuid().parse(match[1]));
    } else if (value && typeof value === "object") Object.values(value).forEach(scan);
  };
  scan(claims);
  if (sites.size !== 1)
    throw new ConnectorError("grant_mismatch", "Atlassian MCP must grant exactly one site.");
  return grantSchema.parse({
    resource: target.resource,
    accountId,
    cloudId: [...sites][0],
    scopes: credentials.grantedScopes,
  });
}

export async function exchangeAtlassianMcpTokens(
  input: {
    scopes: string[];
    callbackUrl?: string;
    code?: string;
    attempt?: unknown;
    previous?: unknown;
  },
  fetchFn = createAtlassianOAuthFetch(),
) {
  const previous =
    input.previous === undefined ? undefined : credentialsSchema.parse(input.previous);
  const operation = previous ? "refresh" : "authorization";
  let phase = "discovery";
  let unexpectedScopeCount = 0;
  try {
    const metadata = await discover(fetchFn, input.scopes);
    phase = "attempt_validation";
    const attempt = previous ? undefined : attemptSchema.parse(input.attempt);
    if (attempt && attempt.callbackUrl !== input.callbackUrl) throw new Error();
    const clientId = previous?.clientId ?? attempt!.clientId;
    phase = "token_request";
    const value = previous
      ? await refreshAuthorization(target.issuer, {
          metadata,
          clientInformation: client(clientId),
          refreshToken: previous.refreshToken,
          resource: new URL(target.resource),
          fetchFn,
        })
      : await exchangeAuthorization(target.issuer, {
          metadata,
          clientInformation: client(clientId),
          authorizationCode: z.string().min(1).max(8192).parse(input.code),
          codeVerifier: attempt!.codeVerifier,
          redirectUri: input.callbackUrl!,
          resource: new URL(target.resource),
          fetchFn,
        });
    phase = "token_response_validation";
    const parsed = z
      .object({
        access_token: token,
        refresh_token: token,
        token_type: z.string().refine((s) => s.toLowerCase() === "bearer"),
        expires_in: z.number().int().positive().max(86400),
        scope: z.string().max(8192).optional(),
      })
      .safeParse(value);
    if (!parsed.success) throw new RejectedProviderCredentials({ credentials: value });
    const normalized = credentialsSchema.safeParse({
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
      clientId,
      // An omitted refresh scope retains the previous grant, not all originally requested scopes.
      grantedScopes: canonicalScopes(
        parsed.data.scope === undefined
          ? (previous?.grantedScopes ?? input.scopes)
          : parsed.data.scope.split(" ").filter(Boolean),
      ),
    });
    if (!normalized.success) throw new RejectedProviderCredentials({ credentials: value });
    const credentials = normalized.data;
    try {
      phase = "scope_validation";
      unexpectedScopeCount = credentials.grantedScopes.filter(
        (scope) => !input.scopes.includes(scope),
      ).length;
      if (unexpectedScopeCount) throw new Error();
      phase = "identity_validation";
      const grant = grantFromCredentials(credentials);
      if (previous) {
        phase = "identity_continuity";
        const old = grantFromCredentials(previous);
        if (grant.accountId !== old.accountId || grant.cloudId !== old.cloudId) throw new Error();
      }
      const missingScopes = canonicalScopes(
        input.scopes.filter((scope) => !credentials.grantedScopes.includes(scope)),
      );
      if (missingScopes.length)
        logger.warn(
          {
            event: "connector.oauth.scopes_reduced",
            provider: "atlassian-mcp",
            operation,
            missingScopes,
            grantedScopeCount: credentials.grantedScopes.length,
          },
          "Atlassian granted fewer scopes than requested; accepting the reduced grant",
        );
      return { credentials, grant };
    } catch {
      throw new RejectedProviderCredentials({ credentials });
    }
  } catch (error) {
    // Never log the thrown object: OAuth/validation errors may contain credentials or response bodies.
    logger.error(
      {
        event: "connector.oauth.failed",
        provider: "atlassian-mcp",
        operation,
        phase,
        failureReason:
          error instanceof RejectedProviderCredentials
            ? "credentials_rejected"
            : error instanceof InvalidGrantError
              ? "invalid_grant"
              : error instanceof InvalidClientError
                ? "invalid_client"
                : "provider_error",
        ...(phase === "scope_validation" ? { unexpectedScopeCount } : {}),
      },
      "Atlassian MCP token exchange failed",
    );
    if (error instanceof RejectedProviderCredentials) throw error;
    throw new ProviderTokenError({
      authorizationLost: error instanceof InvalidGrantError || error instanceof InvalidClientError,
    });
  }
}
