import { randomUUID } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import { JWT_DPOP_DRAFT, JWT_DPOP_GRANT } from "./constants.js";
import { isSha256JwkThumbprint } from "./crypto.js";
import { WeldallDiscovery } from "./discovery.js";
import { verifyStrictDpop } from "./dpop.js";
import { WeldallAuthError, oauthErrorResponse } from "./errors.js";
import { hasVerifiedEmail } from "./identity.js";
import { parseScope } from "./scope.js";
import { consumeReplay } from "./replay.js";
import { loadSkillCatalog, SKILL_ASSERTION_TYPE, SKILL_CATALOG_PATH } from "./skills.js";
import {
  assertSigningConfig,
  createSigningProvider,
  signWithProvider,
  validatedJwks,
} from "./signing.js";
import type {
  AuthContext,
  IdJagClaims,
  ScopePolicy,
  VerifyResult,
  WeldallOptions,
} from "./types.js";

const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const uniqueScopes = (values: readonly string[], label: string): string[] => {
  if (
    !Array.isArray(values) ||
    values.some((v) => typeof v !== "string" || !scopePattern.test(v)) ||
    new Set(values).size !== values.length
  )
    throw new TypeError(`${label} must contain unique valid OAuth scope tokens`);
  return [...values];
};
const parseUrl = (
  value: string,
  label: string,
  originOnly: boolean,
  allowInsecureLoopback: boolean,
): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:"))
    throw new TypeError(`${label} must use HTTPS`);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (originOnly && (url.pathname !== "/" || url.search))
  )
    throw new TypeError(`${label} must be an origin without credentials, path, query, or fragment`);
  return url;
};
export function initWeldall(host: string, options: WeldallOptions) {
  if (typeof host !== "string" || !host) throw new TypeError("Weldall host is required");
  if (!options || typeof options !== "object") throw new TypeError("Weldall options are required");
  const allowInsecure = options.allowInsecureLoopback === true;
  const hostUrl = parseUrl(host, "Weldall host", true, allowInsecure);
  const publicOriginUrl = parseUrl(options.publicOrigin, "publicOrigin", true, allowInsecure);
  const resourceUrl = parseUrl(options.resource, "resource", false, allowInsecure);
  if (resourceUrl.search) throw new TypeError("resource must not contain a query");
  if (typeof options.clientId !== "string" || !options.clientId.trim())
    throw new TypeError("clientId is required");
  const supportedScopes = uniqueScopes(options.supportedScopes, "supportedScopes");
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(discoveryTimeoutMs) ||
    discoveryTimeoutMs < 100 ||
    discoveryTimeoutMs > 30_000
  )
    throw new TypeError("discoveryTimeoutMs must be an integer between 100 and 30000");
  if (
    options.replayStore !== "disabled" &&
    (!options.replayStore || typeof options.replayStore.consume !== "function")
  )
    throw new TypeError("replayStore is required");
  if (options.skills) {
    const hasItems = "items" in options.skills && Array.isArray(options.skills.items);
    const hasLoader = "load" in options.skills && typeof options.skills.load === "function";
    if (hasItems === hasLoader)
      throw new TypeError("skills must configure exactly one of items or load");
    if (options.replayStore === "disabled")
      throw new TypeError("skill publication requires replay protection");
  }
  assertSigningConfig(options.signingKey);
  const issuer = publicOriginUrl.origin;
  const resource = resourceUrl.toString();
  const clientId = options.clientId;
  const replayStore = options.replayStore;
  const signing = createSigningProvider(options.signingKey);
  const discovery = new WeldallDiscovery(hostUrl.origin, discoveryTimeoutMs);
  const tokenEndpoint = `${issuer}/oauth/token`;
  const skillsEndpoint = `${issuer}${SKILL_CATALOG_PATH}`;

  const ready = async () => {
    await Promise.all([discovery.ready(), validatedJwks(signing)]);
  };

  const verifyIdJagAssertion = async (assertion: string): Promise<IdJagClaims> => {
    const validate = async (refresh: boolean) => {
      const { kid, jwk } = await discovery.getKey(assertion, refresh);
      const result = await jwtVerify(assertion, await importJWK(jwk, "ES256"), {
        algorithms: ["ES256"],
        issuer: hostUrl.origin,
        audience: issuer,
        requiredClaims: ["iss", "sub", "email", "email_verified", "aud", "exp", "iat", "jti"],
        maxTokenAge: "5m",
        clockTolerance: 5,
      });
      if (decodeProtectedHeader(assertion).kid !== kid) throw new Error("kid");
      return result.payload;
    };
    let payload: JWTPayload;
    try {
      payload = await validate(false);
    } catch (firstError) {
      if (firstError instanceof WeldallAuthError) throw firstError;
      try {
        payload = await validate(true);
      } catch (error) {
        if (error instanceof WeldallAuthError && error.code === "temporarily_unavailable")
          throw error;
        throw new WeldallAuthError("invalid_grant", "ID-JAG validation failed");
      }
    }
    const scopes = parseScope(payload.scope);
    const cnf = payload.cnf as { jkt?: unknown } | undefined;
    if (
      payload.aud !== issuer ||
      payload.resource !== resource ||
      payload.client_id !== clientId ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      !hasVerifiedEmail(payload) ||
      typeof payload.jti !== "string" ||
      payload.jti.length < 1 ||
      payload.jti.length > 128 ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) > 300 ||
      !isSha256JwkThumbprint(cnf?.jkt) ||
      payload["urn:weldall:id-jag-draft"] !==
        "draft-ietf-oauth-identity-assertion-authz-grant-04" ||
      !scopes
    )
      throw new WeldallAuthError("invalid_grant", "invalid ID-JAG claims");
    if (scopes.some((scope) => !supportedScopes.includes(scope)))
      throw new WeldallAuthError("invalid_scope", "ID-JAG requested an unsupported scope");
    return payload as IdJagClaims;
  };

  const verifySkillAssertion = async (assertion: string): Promise<JWTPayload> => {
    const validate = async (refresh: boolean) => {
      const { kid, jwk } = await discovery.getSigningKey(assertion, SKILL_ASSERTION_TYPE, refresh);
      const result = await jwtVerify(assertion, await importJWK(jwk, "ES256"), {
        algorithms: ["ES256"],
        issuer: hostUrl.origin,
        audience: skillsEndpoint,
        requiredClaims: ["iss", "sub", "aud", "resource", "purpose", "exp", "iat", "jti"],
        maxTokenAge: "60s",
        clockTolerance: 5,
      });
      if (decodeProtectedHeader(assertion).kid !== kid) throw new Error("kid");
      return result.payload;
    };
    let payload: JWTPayload;
    try {
      payload = await validate(false);
    } catch (firstError) {
      if (firstError instanceof WeldallAuthError && firstError.code === "temporarily_unavailable")
        throw firstError;
      try {
        payload = await validate(true);
      } catch (error) {
        if (error instanceof WeldallAuthError && error.code === "temporarily_unavailable")
          throw error;
        throw new WeldallAuthError("invalid_token", "skill assertion validation failed", 401);
      }
    }
    if (
      payload.iss !== hostUrl.origin ||
      payload.sub !== hostUrl.origin ||
      payload.aud !== skillsEndpoint ||
      payload.resource !== resource ||
      payload.purpose !== "skills:read" ||
      typeof payload.jti !== "string" ||
      payload.jti.length < 1 ||
      payload.jti.length > 128 ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) > 60
    ) {
      throw new WeldallAuthError("invalid_token", "invalid skill assertion claims", 401);
    }
    await consumeReplay(
      replayStore,
      "skills",
      payload.jti,
      new Date(((payload.exp as number) + 6) * 1000),
      {
        code: "invalid_token",
        message: "skill assertion was already used",
        status: 401,
      },
    );
    return payload;
  };

  const skills = async (request: Request): Promise<Response> => {
    if (!options.skills) return new Response(null, { status: 404 });
    try {
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers: { allow: "GET" } });
      const authorization = request.headers.get("authorization");
      const match = authorization?.match(/^Bearer ([^\s,]+)$/);
      if (!match)
        throw new WeldallAuthError(
          "invalid_token",
          "exactly one Bearer assertion is required",
          401,
        );
      await verifySkillAssertion(match[1]!);
      const catalog = await loadSkillCatalog(options.skills, resource);
      return Response.json(catalog, {
        headers: { "cache-control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof WeldallAuthError) return oauthErrorResponse(error);
      return Response.json(
        {
          error: "temporarily_unavailable",
          error_description: "Skill catalog unavailable",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  };

  const token = async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST")
        throw new WeldallAuthError("invalid_request", "token endpoint requires POST");
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/x-www-form-urlencoded")
        throw new WeldallAuthError("invalid_request", "form content type required");
      const raw = await request.text();
      if (raw.length > 64_000) throw new WeldallAuthError("invalid_request", "form is too large");
      const form = new URLSearchParams(raw);
      if (
        [...form.keys()].some((name) => !["grant_type", "assertion"].includes(name)) ||
        form.getAll("grant_type").length !== 1 ||
        form.getAll("assertion").length !== 1
      )
        throw new WeldallAuthError("invalid_request", "invalid or duplicate OAuth parameter");
      if (form.get("grant_type") !== JWT_DPOP_GRANT)
        throw new WeldallAuthError("unsupported_grant_type");
      const assertion = form.get("assertion")!;
      const proof = request.headers.get("dpop");
      if (!proof || proof.includes(","))
        throw new WeldallAuthError("invalid_dpop_proof", "exactly one DPoP proof is required");
      const jag = await verifyIdJagAssertion(assertion);
      await verifyStrictDpop(proof, {
        method: "POST",
        url: tokenEndpoint,
        replay: replayStore,
        expectedJkt: jag.cnf.jkt,
      });
      await consumeReplay(replayStore, "id-jag", jag.jti, new Date((jag.exp + 6) * 1000), {
        code: "invalid_grant",
        message: "ID-JAG was already used",
      });
      const now = Math.floor(Date.now() / 1000);
      const payload: JWTPayload = {
        iss: issuer,
        sub: jag.sub,
        email: jag.email,
        email_verified: true,
        aud: resource,
        client_id: clientId,
        scope: jag.scope,
        cnf: { jkt: jag.cnf.jkt },
        jti: randomUUID(),
        iat: now,
        exp: now + 600,
      };
      const accessToken = await signWithProvider(signing, payload, "at+jwt");
      return Response.json(
        {
          access_token: accessToken,
          token_type: "DPoP",
          expires_in: 600,
          scope: jag.scope,
        },
        { headers: { "cache-control": "no-store", pragma: "no-cache" } },
      );
    } catch (error) {
      return oauthErrorResponse(error);
    }
  };

  const verify = async (request: Request, policy: ScopePolicy = {}): Promise<AuthContext> => {
    const required = uniqueScopes(policy.scopes ?? [], "policy.scopes");
    const any = uniqueScopes(policy.anyScopes ?? [], "policy.anyScopes");
    const authorization = request.headers.get("authorization");
    const match = authorization?.match(/^DPoP ([^\s,]+)$/);
    const proof = request.headers.get("dpop");
    if (!match || !proof || proof.includes(","))
      throw new WeldallAuthError("invalid_token", "DPoP authorization required", 401);
    const accessToken = match[1]!;
    let payload: JWTPayload;
    try {
      const keys = await validatedJwks(signing);
      ({ payload } = await jwtVerify(
        accessToken,
        async (header) => {
          if (
            header.alg !== "ES256" ||
            header.typ !== "at+jwt" ||
            header.crit ||
            typeof header.kid !== "string"
          )
            throw new Error("invalid header");
          const jwk = keys.find((candidate) => candidate.kid === header.kid);
          if (!jwk) throw new Error("unknown kid");
          return importJWK(jwk, "ES256");
        },
        {
          algorithms: ["ES256"],
          issuer,
          audience: resource,
          requiredClaims: ["iss", "sub", "email", "email_verified", "aud", "exp", "iat", "jti"],
          maxTokenAge: "10m",
          clockTolerance: 5,
        },
      ));
    } catch (error) {
      if (error instanceof WeldallAuthError) throw error;
      throw new WeldallAuthError("invalid_token", "access token validation failed", 401);
    }
    const granted = parseScope(payload.scope);
    const cnf = payload.cnf as { jkt?: unknown } | undefined;
    if (
      payload.aud !== resource ||
      payload.client_id !== clientId ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      !hasVerifiedEmail(payload) ||
      typeof payload.jti !== "string" ||
      payload.jti.length < 1 ||
      payload.jti.length > 128 ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) > 600 ||
      !granted ||
      !isSha256JwkThumbprint(cnf?.jkt)
    )
      throw new WeldallAuthError("invalid_token", "invalid access token claims", 401);
    const incoming = new URL(request.url);
    const publicUrl = new URL(issuer);
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
    const missingAll = required.filter((scope) => !granted.includes(scope));
    if (missingAll.length || (any.length && !any.some((scope) => granted.includes(scope))))
      throw new WeldallAuthError("insufficient_scope", "required scope is missing", 403, [
        ...required,
        ...any,
      ]);
    return {
      identity: {
        subject: payload.sub,
        email: payload.email,
        emailVerified: true,
      },
      subject: payload.sub,
      email: payload.email,
      emailVerified: true,
      scopes: granted,
      tokenId: payload.jti,
      clientId,
    };
  };

  const verifyNoThrow = async (request: Request, policy?: ScopePolicy): Promise<VerifyResult> => {
    try {
      return { ok: true, auth: await verify(request, policy) };
    } catch (error) {
      const known =
        error instanceof WeldallAuthError
          ? error
          : new WeldallAuthError("invalid_token", "request rejected", 401);
      return { ok: false, error: known, response: oauthErrorResponse(known) };
    }
  };

  const handlers = {
    token,
    authorizationServerMetadata: async (_request?: Request) =>
      Response.json({
        issuer,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        grant_types_supported: [JWT_DPOP_GRANT],
        response_types_supported: [],
        token_endpoint_auth_methods_supported: ["none"],
        dpop_signing_alg_values_supported: ["ES256"],
        "urn:weldall:jwt-dpop-draft": JWT_DPOP_DRAFT,
      }),
    protectedResourceMetadata: async (_request?: Request) =>
      Response.json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: supportedScopes,
        bearer_methods_supported: ["header"],
        dpop_signing_alg_values_supported: ["ES256"],
        ...(options.skills ? { weldall_skills_endpoint: skillsEndpoint } : {}),
      }),
    skills,
    jwks: async (_request?: Request) => Response.json({ keys: await validatedJwks(signing) }),
  };
  return {
    host: hostUrl.origin,
    issuer,
    resource,
    tokenEndpoint,
    skillsEndpoint: options.skills ? skillsEndpoint : undefined,
    ready,
    verify,
    verifyNoThrow,
    handlers,
  };
}

export type Weldall = ReturnType<typeof initWeldall>;
