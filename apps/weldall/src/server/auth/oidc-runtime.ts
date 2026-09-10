import * as openid from "openid-client";
import { z } from "zod";
import {
  discoveryUrl,
  httpsUrlSchema,
  LoginError,
  verifiedIdentity,
  type ProviderConfig,
} from "./oidc-config";
import { digest } from "./oidc-credentials";

const algorithms = ["RS256", "ES256", "EdDSA"];
const metadataSchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: httpsUrlSchema,
    token_endpoint: httpsUrlSchema,
    jwks_uri: httpsUrlSchema,
    response_types_supported: z.array(z.string()),
    id_token_signing_alg_values_supported: z.array(z.string()),
    token_endpoint_auth_methods_supported: z.array(z.string()).default(["client_secret_basic"]),
    code_challenge_methods_supported: z.array(z.string()).optional(),
  })
  .passthrough();
const reservedParameters = new Set([
  "response_type",
  "response_mode",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge_method",
  "code_challenge",
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
  "iss",
  "error",
  "error_description",
  "error_uri",
]);
const cache = new Map<string, { expires: number; value: Promise<openid.Configuration> }>();
async function configuration(config: ProviderConfig): Promise<openid.Configuration> {
  const key = digest(
    JSON.stringify([
      config.issuer,
      discoveryUrl(config),
      config.clientId,
      config.clientSecret,
      config.tokenEndpointAuthMethod,
      algorithms,
      30,
    ]),
  );
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = (async () => {
    try {
      const auth =
        config.tokenEndpointAuthMethod === "client_secret_basic"
          ? openid.ClientSecretBasic(config.clientSecret)
          : openid.ClientSecretPost(config.clientSecret);
      const client = { [openid.clockTolerance]: 30 };
      // Explicit document URLs need not contain /.well-known/; discovery() cannot infer those.
      const metadata = config.discoveryUrl
        ? await fetch(config.discoveryUrl, {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "manual",
            signal: AbortSignal.timeout(8000),
          }).then(async (response) => {
            if (response.status !== 200) throw new LoginError("invalid_discovery");
            return response.json();
          })
        : (
            await openid.discovery(new URL(config.issuer), config.clientId, client, auth, {
              timeout: 8,
            })
          ).serverMetadata();
      const data = metadataSchema.parse(metadata);
      for (const endpoint of [data.authorization_endpoint, data.token_endpoint, data.jwks_uri]) {
        for (const name of new URL(endpoint).searchParams.keys()) {
          if (reservedParameters.has(name.toLowerCase())) throw new LoginError("invalid_discovery");
        }
      }
      data.id_token_signing_alg_values_supported =
        data.id_token_signing_alg_values_supported.filter((algorithm) =>
          algorithms.includes(algorithm),
        );
      if (
        data.issuer !== config.issuer ||
        !data.response_types_supported.includes("code") ||
        !data.id_token_signing_alg_values_supported.length ||
        !data.token_endpoint_auth_methods_supported.includes(config.tokenEndpointAuthMethod) ||
        (data.code_challenge_methods_supported &&
          !data.code_challenge_methods_supported.includes("S256"))
      )
        throw new LoginError("invalid_discovery");
      const result = new openid.Configuration(
        data as openid.ServerMetadata,
        config.clientId,
        client,
        auth,
      );
      result.timeout = 8;
      openid.enableNonRepudiationChecks(result);
      return result;
    } catch (error) {
      if (error instanceof LoginError) throw error;
      throw new LoginError("invalid_discovery");
    }
  })();
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 300_000, value });
  try {
    return await value;
  } catch (error) {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  }
}
export async function discover(config: ProviderConfig): Promise<void> {
  await configuration(config);
}
export async function authorizationUrl(
  config: ProviderConfig,
  callback: string,
  state: string,
  nonce: string,
  verifier: string,
) {
  return openid
    .buildAuthorizationUrl(await configuration(config), {
      redirect_uri: callback,
      scope: config.scopes.join(" "),
      response_type: "code",
      response_mode: "query",
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: await openid.calculatePKCECodeChallenge(verifier),
    })
    .toString();
}
export async function verifyCallback(
  config: ProviderConfig,
  callback: URL,
  state: string,
  nonce: string,
  verifier: string,
) {
  try {
    const tokens = await openid.authorizationCodeGrant(await configuration(config), callback, {
      expectedState: state,
      expectedNonce: nonce,
      pkceCodeVerifier: verifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims()!;
    const now = Math.floor(Date.now() / 1000);
    // Application policy is stricter than OIDC: current issuance and azp even for one audience.
    if (
      claims.iat < now - 630 ||
      claims.iat > now + 30 ||
      (claims.azp !== undefined && claims.azp !== config.clientId)
    )
      throw new LoginError("invalid_id_token");
    return verifiedIdentity(claims, config);
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError(
      error instanceof openid.AuthorizationResponseError
        ? "authorization_cancelled"
        : "invalid_id_token",
    );
  }
}
