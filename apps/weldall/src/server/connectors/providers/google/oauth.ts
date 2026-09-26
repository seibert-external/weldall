import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { ConnectorError, ProviderTokenError, RejectedProviderCredentials } from "../../errors";
import { canonicalizeScopes } from "./setup";
import { readBoundedBody } from "../../core/transport";

const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
export const credentialsSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number(),
    grantedScopes: z.array(z.string()),
  })
  .strict();
export type Credentials = z.infer<typeof credentialsSchema>;
/** Failed identity verification retains only enough material to revoke, never to execute or refresh. */
const revocationCredentialsSchema = z.object({ revocationToken: z.string().min(1) }).strict();
export function googleRevocationToken(credentials: unknown): string {
  const cleanup = revocationCredentialsSchema.safeParse(credentials);
  return cleanup.success
    ? cleanup.data.revocationToken
    : credentialsSchema.parse(credentials).refreshToken;
}
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** Parses a bounded JSON response from Google's OAuth endpoints. */
async function readGoogleJsonResponse({
  response,
  signal,
}: {
  response: Response;
  signal: AbortSignal;
}) {
  return JSON.parse(
    Buffer.from(await readBoundedBody({ response, maximum: 64_000, signal })).toString("utf8"),
  ) as unknown;
}
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().max(86400),
  token_type: z.string(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
/** Exchanges an authorization code or refresh token through Google's OAuth token endpoint. */
async function exchangeGoogleToken(body: URLSearchParams) {
  const signal = AbortSignal.timeout(10_000);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body,
    redirect: "error",
    signal,
  });
  const value = await readGoogleJsonResponse({ response, signal });
  if (!response.ok)
    throw new ProviderTokenError({
      authorizationLost: z.object({ error: z.literal("invalid_grant") }).safeParse(value).success,
      retryable:
        z.object({ error: z.enum(["temporarily_unavailable", "server_error"]) }).safeParse(value)
          .success || response.status === 429,
    });
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer")
    throw new ProviderTokenError({ authorizationLost: false });
  return parsed.data;
}
/** Builds the Google consent URL used by the owner-facing connection setup flow. */
export function buildGoogleAuthorizationUrl({
  clientId,
  redirectUri,
  state,
  nonce,
  challenge,
  selected,
}: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  selected: string[];
}) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: selected.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}
/** Converts Google's token response into Weldall's encrypted credential payload. */
function buildGoogleCredentials({
  value,
  refreshToken,
  priorScopes = [],
}: {
  value: z.infer<typeof tokenSchema>;
  refreshToken: string;
  priorScopes?: string[];
}): Credentials {
  return {
    accessToken: value.access_token,
    refreshToken,
    expiresAt: Date.now() + value.expires_in * 1000,
    grantedScopes:
      value.scope === undefined
        ? priorScopes
        : canonicalizeScopes(value.scope.split(" ").filter(Boolean)),
  };
}
/** Completes Google OAuth and verifies the selected account before Weldall stores credentials. */
export async function completeGoogleAuthorization({
  client,
  input,
}: {
  client: GoogleClient;
  input: { code: string; redirectUri: string; nonce: string; verifier: string };
}) {
  const value = await exchangeGoogleToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: input.verifier,
    }),
  );
  try {
    if (!value.refresh_token || !value.id_token)
      throw new ProviderTokenError({ authorizationLost: true });
    const { payload } = await jwtVerify(value.id_token, jwks, {
      algorithms: ["RS256"],
      audience: client.clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"],
      maxTokenAge: "10m",
      clockTolerance: 5,
    });
    if (
      payload.nonce !== input.nonce ||
      !payload.sub ||
      typeof payload.email !== "string" ||
      payload.email.length > 320 ||
      payload.email_verified !== true ||
      (payload.azp !== undefined && payload.azp !== client.clientId)
    )
      throw new ProviderTokenError({ authorizationLost: true });
    return {
      accountId: payload.sub,
      accountName: payload.email,
      credentials: buildGoogleCredentials({ value, refreshToken: value.refresh_token }),
    };
  } catch {
    // Token issuance already succeeded. JWKS outages and all identity failures need explicit cleanup.
    // Google's revoke endpoint also accepts an access token when no refresh token was returned.
    throw new RejectedProviderCredentials({
      reason: "identity_unverified",
      credentials: { revocationToken: value.refresh_token ?? value.access_token },
    });
  }
}
/** Refreshes one connection's Google credentials without expanding its persisted consent boundary. */
export async function refreshGoogleCredentials({
  client,
  previous,
}: {
  client: GoogleClient;
  previous: Credentials;
}) {
  const value = await exchangeGoogleToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  );
  return buildGoogleCredentials({
    value,
    refreshToken: value.refresh_token ?? previous.refreshToken,
    priorScopes: previous.grantedScopes,
  });
}
/**
 * Revokes Google's entire account/client grant during explicit disconnect; Weldall never retries
 * automatically because revocation may affect other connections.
 */
export async function revokeGoogleAuthorization(token: string) {
  const signal = AbortSignal.timeout(10_000);
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    body: new URLSearchParams({ token }),
    redirect: "error",
    signal,
  });
  if (response.ok) {
    await readBoundedBody({ response, maximum: 64_000, signal });
    return;
  }
  // An invalid token may be an old token from an interrupted rotation, not proof that
  // the account/client grant was revoked. Keep this outcome explicitly unconfirmed.
  await response.body?.cancel();
  throw new ConnectorError(
    "revocation_unconfirmed",
    "Google revocation is unconfirmed. The connection is blocked; retry disconnect explicitly.",
    502,
  );
}
