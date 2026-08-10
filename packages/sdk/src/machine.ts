import { randomUUID } from "node:crypto";
import { SignJWT, importJWK, type JWK } from "jose";
import { createDpopProof } from "./dpop.js";
import { WeldallAuthError } from "./errors.js";
import type { DpopKeyPair } from "./types.js";

export const PRIVATE_KEY_JWT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const MACHINE_TOKEN_TYP = "weldall-machine+jwt";
export const MACHINE_TOKEN_LIFETIME_SECONDS = 300;

const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const clientPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const kidPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function uniqueTokens(values: readonly string[], label: string): string[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || !scopePattern.test(value)) ||
    new Set(values).size !== values.length
  )
    throw new TypeError(`${label} must contain unique valid OAuth tokens`);
  return [...values];
}

function absoluteUrl(value: string, label: string, originOnly: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    throw new TypeError(`${label} must use HTTPS`);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (originOnly && url.pathname !== "/")
  )
    throw new TypeError(`${label} must be an origin without credentials, path, query, or fragment`);
  return url;
}

export async function createMachineClientAssertion(input: {
  clientId: string;
  tokenEndpoint: string;
  kid: string;
  privateJwk: JWK;
  now?: number;
  jti?: string;
}): Promise<string> {
  if (!clientPattern.test(input.clientId)) throw new TypeError("invalid machine client ID");
  if (!kidPattern.test(input.kid)) throw new TypeError("invalid machine key ID");
  const tokenEndpoint = absoluteUrl(input.tokenEndpoint, "tokenEndpoint", false).toString();
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: input.kid })
    .setIssuer(input.clientId)
    .setSubject(input.clientId)
    .setAudience(tokenEndpoint)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(input.jti ?? randomUUID())
    .sign(await importJWK(input.privateJwk, "ES256"));
}

export async function requestMachineToken(input: {
  issuer: string;
  clientId: string;
  resource: string;
  scopes: readonly string[];
  kid: string;
  key: DpopKeyPair;
  tokenEndpoint?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<{
  accessToken: string;
  tokenType: "DPoP";
  expiresIn: number;
  scope: string;
}> {
  const issuer = absoluteUrl(input.issuer, "issuer", true).origin;
  const tokenEndpoint = absoluteUrl(
    input.tokenEndpoint ?? `${issuer}/api/auth/oauth2/token`,
    "tokenEndpoint",
    false,
  ).toString();
  const scopes = uniqueTokens(input.scopes, "scopes");
  if (!scopes.length) throw new TypeError("at least one scope is required");
  const resource = absoluteUrl(input.resource, "resource", false).toString();
  const assertion = await createMachineClientAssertion({
    clientId: input.clientId,
    tokenEndpoint,
    kid: input.kid,
    privateJwk: input.key.privateJwk,
  });
  const proof = await createDpopProof({
    ...input.key,
    method: "POST",
    url: tokenEndpoint,
  });
  const response = await (input.fetch ?? globalThis.fetch)(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: input.clientId,
      client_assertion_type: PRIVATE_KEY_JWT_ASSERTION_TYPE,
      client_assertion: assertion,
      resource,
      scope: scopes.join(" "),
    }),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok)
    throw new WeldallAuthError(
      typeof body?.error === "string" ? body.error : "server_error",
      "machine token request rejected",
      response.status,
    );
  if (
    typeof body?.access_token !== "string" ||
    body.token_type !== "DPoP" ||
    body.expires_in !== MACHINE_TOKEN_LIFETIME_SECONDS ||
    typeof body.scope !== "string"
  )
    throw new WeldallAuthError("server_error", "invalid machine token response", 500);
  return {
    accessToken: body.access_token,
    tokenType: "DPoP",
    expiresIn: body.expires_in,
    scope: body.scope,
  };
}
