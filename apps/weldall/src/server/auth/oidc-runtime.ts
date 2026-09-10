import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import {
  discoveryUrl,
  httpsUrlSchema,
  LoginError,
  verifiedIdentity,
  type ProviderConfig,
} from "./oidc-config";
import { digest } from "./oidc-credentials";
import { oidcJson } from "./oidc-transport";
const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: httpsUrlSchema,
  token_endpoint: httpsUrlSchema,
  jwks_uri: httpsUrlSchema,
  userinfo_endpoint: httpsUrlSchema.optional(),
  response_types_supported: z.array(z.string()).max(50),
  id_token_signing_alg_values_supported: z.array(z.string()).max(50),
  token_endpoint_auth_methods_supported: z
    .array(z.string())
    .max(50)
    .default(["client_secret_basic"]),
  code_challenge_methods_supported: z.array(z.string()).max(50).optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
const supportedIdTokenAlgorithms = ["RS256", "ES256", "EdDSA"];
const authorizationParameterNames = new Set([
  "response_type",
  "response_mode",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge_method",
  "code_challenge",
]);
const forbiddenEndpointParameters = new Set([
  "request",
  "request_uri",
  "claims",
  "registration",
  "client_secret",
  "client_assertion",
  "client_assertion_type",
  "access_token",
  "id_token",
  "token",
  "grant_type",
  "code",
  "code_verifier",
]);
function validateEndpointParameters(value: string, authorization: boolean) {
  for (const key of new URL(value).searchParams.keys()) {
    const name = key.toLowerCase();
    if (
      forbiddenEndpointParameters.has(name) ||
      (!authorization && authorizationParameterNames.has(name))
    )
      throw new LoginError("invalid_discovery");
  }
}
const cache = new Map<string, { expires: number; value: Promise<Metadata> }>();
export async function discover(config: ProviderConfig): Promise<Metadata> {
  const cacheKey = digest(
    JSON.stringify([config.issuer, discoveryUrl(config), config.tokenEndpointAuthMethod]),
  );
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = (async () => {
    const parsed = metadataSchema.safeParse(await oidcJson(discoveryUrl(config)));
    if (!parsed.success) throw new LoginError("invalid_discovery");
    const data = parsed.data;
    validateEndpointParameters(data.authorization_endpoint, true);
    validateEndpointParameters(data.token_endpoint, false);
    if (data.userinfo_endpoint) validateEndpointParameters(data.userinfo_endpoint, false);
    if (
      data.issuer !== config.issuer ||
      !data.response_types_supported.includes("code") ||
      !data.id_token_signing_alg_values_supported.some((algorithm) =>
        supportedIdTokenAlgorithms.includes(algorithm),
      ) ||
      !data.token_endpoint_auth_methods_supported.includes(config.tokenEndpointAuthMethod) ||
      (data.code_challenge_methods_supported &&
        !data.code_challenge_methods_supported.includes("S256"))
    )
      throw new LoginError("invalid_discovery");
    return data;
  })();
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { expires: Date.now() + 300_000, value });
  try {
    return await value;
  } catch (error) {
    cache.delete(cacheKey);
    throw error;
  }
}
export async function authorizationUrl(
  config: ProviderConfig,
  callback: string,
  state: string,
  nonce: string,
  verifier: string,
) {
  const metadata = await discover(config);
  const url = new URL(metadata.authorization_endpoint);
  // Preserve fixed endpoint routing parameters, never protocol overrides or duplicate OIDC inputs.
  for (const key of [...url.searchParams.keys()]) {
    if (authorizationParameterNames.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  for (const [key, value] of Object.entries({
    response_type: "code",
    response_mode: "query",
    client_id: config.clientId,
    redirect_uri: callback,
    scope: config.scopes.join(" "),
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: digest(verifier),
  }))
    url.searchParams.set(key, value);
  return url.toString();
}
export async function exchange(
  config: ProviderConfig,
  callback: string,
  code: string,
  nonce: string,
  verifier: string,
) {
  try {
    const metadata = await discover(config);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      code_verifier: verifier,
    });
    let authorization: string | undefined;
    if (config.tokenEndpointAuthMethod === "client_secret_post") {
      body.set("client_id", config.clientId);
      body.set("client_secret", config.clientSecret);
    } else {
      const encode = (v: string) => new URLSearchParams({ v }).toString().slice(2);
      authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString("base64")}`;
    }
    const tokens = await oidcJson(metadata.token_endpoint, { body, authorization });
    if (typeof tokens.id_token !== "string" || tokens.id_token.length > 32768)
      throw new LoginError("invalid_id_token");
    const jwks = await oidcJson(metadata.jwks_uri);
    if (
      !Array.isArray(jwks.keys) ||
      jwks.keys.length < 1 ||
      jwks.keys.length > 50 ||
      jwks.keys.some((k) => !k || typeof k !== "object" || "d" in k || "k" in k)
    )
      throw new LoginError("invalid_jwks");
    const { payload, protectedHeader } = await jwtVerify(
      tokens.id_token,
      createLocalJWKSet(jwks as unknown as JSONWebKeySet),
      {
        algorithms: supportedIdTokenAlgorithms,
        issuer: config.issuer,
        audience: config.clientId,
        clockTolerance: 30,
        requiredClaims: ["exp", "iat", "sub", "nonce"],
        maxTokenAge: 600,
      },
    );
    if (
      !metadata.id_token_signing_alg_values_supported.includes(protectedHeader.alg) ||
      payload.nonce !== nonce ||
      (payload.azp !== undefined && payload.azp !== config.clientId) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
    )
      throw new LoginError("invalid_id_token");
    let identityClaims: Record<string, unknown> = payload;
    const needsUserInfo = payload.email === undefined || payload.email_verified === undefined;
    if (needsUserInfo && metadata.userinfo_endpoint && typeof tokens.access_token === "string") {
      if (tokens.access_token.length > 8192 || !/^[\x21-\x7e]+$/.test(tokens.access_token))
        throw new LoginError("invalid_access_token");
      const info = await oidcJson(metadata.userinfo_endpoint, {
        authorization: `Bearer ${tokens.access_token}`,
      });
      if (info.sub !== payload.sub) throw new LoginError("userinfo_subject_mismatch");
      // Signed ID-token claims always win; UserInfo only fills missing identity fields.
      identityClaims = { ...info, ...payload };
    }
    return verifiedIdentity(identityClaims, config);
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError("invalid_id_token");
  }
}
