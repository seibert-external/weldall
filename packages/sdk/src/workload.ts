import { randomUUID } from "node:crypto";
import {
  SignJWT,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import { isSha256JwkThumbprint } from "./crypto.js";
import { WeldallDiscovery } from "./discovery.js";
import { createDpopProof, verifyStrictDpop } from "./dpop.js";
import { WeldallAuthError, oauthErrorResponse } from "./errors.js";
import { parseScope } from "./scope.js";
import type {
  DpopKeyPair,
  ReplayStore,
  ScopePolicy,
  WorkloadAuthContext,
  WorkloadVerifierOptions,
} from "./types.js";

export const PRIVATE_KEY_JWT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const WORKLOAD_TOKEN_TYP = "weldall-workload+jwt";
export const WORKLOAD_TOKEN_LIFETIME_SECONDS = 300;

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

export async function createWorkloadClientAssertion(input: {
  clientId: string;
  tokenEndpoint: string;
  kid: string;
  privateJwk: JWK;
  now?: number;
  jti?: string;
}): Promise<string> {
  if (!clientPattern.test(input.clientId)) throw new TypeError("invalid workload client ID");
  if (!kidPattern.test(input.kid)) throw new TypeError("invalid workload key ID");
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

export async function requestWorkloadToken(input: {
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
  const assertion = await createWorkloadClientAssertion({
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
      "workload token request rejected",
      response.status,
    );
  if (
    typeof body?.access_token !== "string" ||
    body.token_type !== "DPoP" ||
    body.expires_in !== WORKLOAD_TOKEN_LIFETIME_SECONDS ||
    typeof body.scope !== "string"
  )
    throw new WeldallAuthError("server_error", "invalid workload token response", 500);
  return {
    accessToken: body.access_token,
    tokenType: "DPoP",
    expiresIn: body.expires_in,
    scope: body.scope,
  };
}

export function initWorkloadVerifier(host: string, options: WorkloadVerifierOptions) {
  const hostUrl = absoluteUrl(host, "Weldall host", true);
  const resource = absoluteUrl(options.resource, "resource", false).toString();
  const publicOrigin = absoluteUrl(options.publicOrigin, "publicOrigin", true).origin;
  const supportedScopes = uniqueTokens(options.supportedScopes, "supportedScopes");
  const allowedClientIds = uniqueTokens(options.allowedClientIds, "allowedClientIds");
  if (!allowedClientIds.length) throw new TypeError("allowedClientIds must not be empty");
  if ((options.replayStore as unknown) === "disabled")
    throw new TypeError("workload verification requires replay protection");
  if (!options.replayStore || typeof options.replayStore.consume !== "function")
    throw new TypeError("replayStore is required");
  const replayStore: ReplayStore = options.replayStore;
  const discovery = new WeldallDiscovery(hostUrl.origin, options.discoveryTimeoutMs ?? 5_000);

  const ready = () => discovery.ready();

  const verifyToken = async (token: string): Promise<JWTPayload> => {
    const validate = async (refresh: boolean) => {
      const { kid, jwk } = await discovery.getSigningKey(token, WORKLOAD_TOKEN_TYP, refresh);
      const result = await jwtVerify(token, await importJWK(jwk, "ES256"), {
        algorithms: ["ES256"],
        issuer: hostUrl.origin,
        audience: resource,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti"],
        maxTokenAge: "5m",
        clockTolerance: 5,
      });
      if (decodeProtectedHeader(token).kid !== kid) throw new Error("kid");
      return result.payload;
    };
    try {
      return await validate(false);
    } catch (first) {
      if (first instanceof WeldallAuthError && first.code === "temporarily_unavailable")
        throw first;
      try {
        return await validate(true);
      } catch (second) {
        if (second instanceof WeldallAuthError && second.code === "temporarily_unavailable")
          throw second;
        throw new WeldallAuthError("invalid_token", "workload token validation failed", 401);
      }
    }
  };

  const verify = async (
    request: Request,
    policy: ScopePolicy = {},
  ): Promise<WorkloadAuthContext> => {
    const required = uniqueTokens(policy.scopes ?? [], "policy.scopes");
    const any = uniqueTokens(policy.anyScopes ?? [], "policy.anyScopes");
    const authorization = request.headers.get("authorization");
    const match = authorization?.match(/^DPoP ([^\s,]+)$/);
    const proof = request.headers.get("dpop");
    if (!match || !proof || proof.includes(","))
      throw new WeldallAuthError("invalid_token", "DPoP workload authorization required", 401);
    const accessToken = match[1]!;
    const payload = await verifyToken(accessToken);
    const scopes = parseScope(payload.scope);
    const cnf = payload.cnf as { jkt?: unknown } | undefined;
    const clientId = payload.client_id;
    if (
      typeof payload.aud !== "string" ||
      payload.aud !== resource ||
      typeof clientId !== "string" ||
      !allowedClientIds.includes(clientId) ||
      payload.sub !== `workload:${clientId}` ||
      payload.azp !== clientId ||
      payload.identity_type !== "workload" ||
      payload.token_type !== "workload" ||
      typeof payload.jti !== "string" ||
      payload.jti.length < 1 ||
      payload.jti.length > 128 ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) > WORKLOAD_TOKEN_LIFETIME_SECONDS ||
      !scopes ||
      scopes.some((scope) => !supportedScopes.includes(scope)) ||
      !isSha256JwkThumbprint(cnf?.jkt)
    )
      throw new WeldallAuthError("invalid_token", "invalid workload token claims", 401);
    const incoming = new URL(request.url);
    const publicUrl = new URL(publicOrigin);
    publicUrl.pathname = incoming.pathname;
    publicUrl.search = incoming.search;
    try {
      await verifyStrictDpop(proof, {
        method: request.method,
        url: publicUrl.toString(),
        replay: replayStore,
        accessToken,
        expectedJkt: cnf!.jkt as string,
      });
    } catch (error) {
      if (error instanceof WeldallAuthError && error.code === "invalid_dpop_proof")
        throw new WeldallAuthError(error.code, error.message, 401, [], error.reason);
      throw error;
    }
    if (
      required.some((scope) => !scopes.includes(scope)) ||
      (any.length && !any.some((scope) => scopes.includes(scope)))
    )
      throw new WeldallAuthError("insufficient_scope", "required scope is missing", 403, [
        ...required,
        ...any,
      ]);
    return {
      identity: { type: "workload", clientId, subject: payload.sub },
      identityType: "workload",
      subject: payload.sub,
      clientId,
      scopes,
      tokenId: payload.jti,
    };
  };

  const verifyNoThrow = async (request: Request, policy?: ScopePolicy) => {
    try {
      return { ok: true as const, auth: await verify(request, policy) };
    } catch (error) {
      const known =
        error instanceof WeldallAuthError
          ? error
          : new WeldallAuthError("invalid_token", "request rejected", 401);
      return { ok: false as const, error: known, response: oauthErrorResponse(known) };
    }
  };

  return { host: hostUrl.origin, resource, ready, verify, verifyNoThrow };
}

export type WorkloadVerifier = ReturnType<typeof initWorkloadVerifier>;
