import { createHash, randomBytes } from "node:crypto";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
} from "jose";
import {
  ID_JAG_DRAFT,
  ID_JAG_TOKEN_TYPE,
  createDpopProof,
  generateEs256KeyPair,
  isSha256JwkThumbprint,
  parseScope,
} from "@weldall/sdk";
import type { WeldallConfig } from "../config.js";
import { WELDALL_CLIENT_ID } from "./constants.js";
import { CliError } from "../errors.js";
import type { StoredCredentials } from "../storage/keychain.js";

export const randomValue = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const createPkce = () => {
  const verifier = randomValue(64);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const jsonObject = async (response: Response, label: string): Promise<Record<string, unknown>> => {
  const value = (await response.json().catch(() => null)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CliError(`${label} returned invalid JSON`);
  return value as Record<string, unknown>;
};

async function weldallJwks(config: WeldallConfig) {
  const response = await fetch(config.jwks, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new CliError("Unable to load Weldall signing keys");
  const body = (await response.json()) as Partial<JSONWebKeySet>;
  const kids = new Set<string>();
  if (
    !Array.isArray(body.keys) ||
    body.keys.length < 1 ||
    body.keys.some((key) => {
      if (
        typeof key.kid !== "string" ||
        !key.kid ||
        kids.has(key.kid) ||
        key.alg !== "ES256" ||
        key.kty !== "EC" ||
        key.crv !== "P-256" ||
        !key.x ||
        !key.y ||
        key.d ||
        (key.use !== undefined && key.use !== "sig")
      )
        return true;
      kids.add(key.kid);
      return false;
    })
  )
    throw new CliError("Weldall returned an invalid signing-key set");
  return createLocalJWKSet(body as JSONWebKeySet);
}

export async function validateAccessToken(
  config: WeldallConfig,
  token: string,
  publicJwk: JWK,
): Promise<JWTPayload & { sub: string }> {
  const result = await jwtVerify(token, await weldallJwks(config), {
    algorithms: ["ES256"],
    issuer: config.issuer,
    audience: config.resource,
    typ: "at+jwt",
    requiredClaims: ["iss", "aud", "sub", "exp", "iat", "client_id", "cnf"],
    clockTolerance: 5,
  });
  const audiences =
    typeof result.payload.aud === "string"
      ? [result.payload.aud]
      : Array.isArray(result.payload.aud) &&
          result.payload.aud.every((audience) => typeof audience === "string")
        ? result.payload.aud
        : [];
  if (
    !decodeProtectedHeader(token).kid ||
    typeof result.payload.sub !== "string" ||
    !result.payload.sub ||
    !audiences.includes(config.resource) ||
    new Set(audiences).size !== audiences.length ||
    result.payload.client_id !== WELDALL_CLIENT_ID ||
    (audiences.length > 1 && result.payload.azp !== WELDALL_CLIENT_ID)
  )
    throw new CliError("Weldall returned an invalid access token");
  const expectedJkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const jkt = (result.payload.cnf as { jkt?: unknown } | undefined)?.jkt;
  if (!isSha256JwkThumbprint(jkt) || jkt !== expectedJkt)
    throw new CliError("Weldall returned an access token for a different device key");
  return result.payload as JWTPayload & { sub: string };
}

export async function tokenRequest(
  config: WeldallConfig,
  body: URLSearchParams,
  key: { privateJwk: JWK; publicJwk: JWK },
) {
  const proof = await createDpopProof({ ...key, method: "POST", url: config.token });
  const response = await fetch(config.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
    body,
    redirect: "error",
  });
  const value = await jsonObject(response, "Weldall token endpoint");
  if (!response.ok) {
    const error = typeof value.error === "string" ? value.error : "token request failed";
    const description =
      typeof value.error_description === "string" ? value.error_description : undefined;
    throw new CliError(description ? `${error}: ${description}` : error);
  }
  return value;
}

export async function validateLoginResponse(
  config: WeldallConfig,
  result: Record<string, unknown>,
  key: { publicJwk: JWK },
  nonce: string,
) {
  if (
    result.token_type !== "DPoP" ||
    typeof result.access_token !== "string" ||
    typeof result.refresh_token !== "string" ||
    typeof result.id_token !== "string"
  )
    throw new CliError("Weldall returned an invalid login response");
  const access = await validateAccessToken(config, result.access_token, key.publicJwk);
  const id = await jwtVerify(result.id_token, await weldallJwks(config), {
    algorithms: ["ES256"],
    issuer: config.issuer,
    audience: WELDALL_CLIENT_ID,
    typ: "JWT",
    requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"],
    clockTolerance: 5,
  });
  if (
    id.payload.aud !== WELDALL_CLIENT_ID ||
    id.payload.nonce !== nonce ||
    id.payload.sub !== access.sub
  )
    throw new CliError("Weldall returned an invalid ID-token binding");
  return { refreshToken: result.refresh_token, subject: access.sub };
}

export async function validateIdJagResponse(
  config: WeldallConfig,
  result: Record<string, unknown>,
  publicJwk: JWK,
  expected: {
    authorizationServer: string;
    resource: string;
    clientId: string;
    scopes: readonly string[];
  },
): Promise<string> {
  const requestedScopes = [...new Set(expected.scopes)].sort();
  const expectedScope = requestedScopes.join(" ");
  if (
    result.token_type !== "N_A" ||
    result.issued_token_type !== ID_JAG_TOKEN_TYPE ||
    typeof result.access_token !== "string" ||
    result.scope !== expectedScope ||
    typeof result.expires_in !== "number" ||
    result.expires_in < 1 ||
    result.expires_in > 300
  )
    throw new CliError("Weldall returned an invalid ID-JAG response");

  const verified = await jwtVerify(result.access_token, await weldallJwks(config), {
    algorithms: ["ES256"],
    issuer: config.issuer,
    audience: expected.authorizationServer,
    typ: "oauth-id-jag+jwt",
    requiredClaims: [
      "iss",
      "aud",
      "sub",
      "exp",
      "iat",
      "jti",
      "client_id",
      "resource",
      "scope",
      "cnf",
    ],
    maxTokenAge: "5m",
    clockTolerance: 5,
  });
  if (!verified.protectedHeader.kid) throw new CliError("The ID-JAG has no signing-key ID");
  const claims = verified.payload;
  const scopes = parseScope(claims.scope);
  const cnf = claims.cnf;
  const expectedJkt = await calculateJwkThumbprint(publicJwk, "sha256");
  if (
    claims.aud !== expected.authorizationServer ||
    claims.resource !== expected.resource ||
    claims.client_id !== expected.clientId ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    typeof claims.jti !== "string" ||
    claims.jti.length < 1 ||
    claims.jti.length > 128 ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    (claims.exp as number) <= (claims.iat as number) ||
    (claims.exp as number) - (claims.iat as number) > 300 ||
    !cnf ||
    typeof cnf !== "object" ||
    Array.isArray(cnf) ||
    !isSha256JwkThumbprint((cnf as { jkt?: unknown }).jkt) ||
    (cnf as { jkt: string }).jkt !== expectedJkt ||
    claims["urn:weldall:id-jag-draft"] !== ID_JAG_DRAFT ||
    !scopes ||
    scopes.length !== requestedScopes.length ||
    [...scopes].sort().some((scope, index) => scope !== requestedScopes[index])
  )
    throw new CliError("Weldall returned invalid ID-JAG claims");
  return result.access_token;
}

export async function refresh(config: WeldallConfig, credentials: StoredCredentials) {
  const result = await tokenRequest(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: WELDALL_CLIENT_ID,
    }),
    credentials,
  );
  if (
    result.token_type !== "DPoP" ||
    typeof result.access_token !== "string" ||
    typeof result.refresh_token !== "string"
  )
    throw new CliError("Weldall returned an invalid refresh response");
  const claims = await validateAccessToken(config, result.access_token, credentials.publicJwk);
  return {
    credentials: { ...credentials, refreshToken: result.refresh_token },
    accessToken: result.access_token,
    subject: claims.sub,
  };
}

export { generateEs256KeyPair };
