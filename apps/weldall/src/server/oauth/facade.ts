import { createHash, randomUUID } from "node:crypto";
import { db, LOGIN_SCOPE_KEY, type OAuthDeviceRefreshBinding } from "@weldall/db";
import { decodeJwt } from "jose";
import {
  ID_JAG_TOKEN_TYPE,
  WeldallAuthError,
  REFRESH_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  issueIdJag,
  safeEqual,
  verifyEs256,
  verifyStrictDpop,
} from "@weldall/sdk";
import {
  WELDALL_CLIENT_ID,
  WELDALL_ISSUER,
  WELDALL_RESOURCE,
  WELDALL_REVOCATION_ENDPOINT,
  WELDALL_TOKEN_ENDPOINT,
} from "./constants";
import type { AuditEventType, AuditReasonCode } from "../../lib/audit";
import { auditRequestIdentifiers, prismaAuditWriter, type AuditWriter } from "../audit/service";
import { auth } from "../auth/auth";
import { errorForLog, logger } from "../observability/logger";
import { hasLoginScopeForUserId } from "../auth/login-policy";
import { exchangePolicyRequiringSystemScopeFor } from "../policy/resources";
import { getWeldallSigningKey } from "./jwt";
import { loggedOauthErrorResponse } from "./error-response";
import { auditMachineFailure, issueMachineToken, machineAuditContext } from "./machine";
import { postgresReplayStore } from "./replay";

const hash = (value: string) => createHash("sha256").update(value, "ascii").digest("base64url");
const confirmationJkt = (value: unknown): string | undefined => {
  let confirmation = value;
  if (typeof confirmation === "string") {
    try {
      confirmation = JSON.parse(confirmation);
    } catch {
      return undefined;
    }
  }
  if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation))
    return undefined;
  const jkt = (confirmation as Record<string, unknown>).jkt;
  return typeof jkt === "string" && jkt.length > 0 ? jkt : undefined;
};
const replay = postgresReplayStore;
interface ExchangeAuditContext {
  requestId: string;
  correlationId?: string;
  actorId: string;
  actorEmail?: string;
  actorType: "user" | "oauth_client" | "anonymous";
  clientId?: string;
  audience: string | null;
  resource: string | null;
  requestedScopes: string[];
}

const securityParameters = [
  "grant_type",
  "code",
  "redirect_uri",
  "code_verifier",
  "refresh_token",
  "token",
  "token_type_hint",
  "client_id",
  "requested_token_type",
  "audience",
  "resource",
  "scope",
  "subject_token",
  "subject_token_type",
  "client_assertion_type",
  "client_assertion",
] as const;

function rejectDuplicateParameters(form: FormData): void {
  if (securityParameters.some((name) => form.getAll(name).length > 1))
    throw new WeldallAuthError("invalid_request", "duplicate OAuth parameter");
}

function requiredString(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string") throw new WeldallAuthError("invalid_request", `missing ${name}`);
  return value;
}

async function oauthForm(request: Request): Promise<FormData> {
  if (request.method !== "POST") {
    throw new WeldallAuthError("invalid_request", "OAuth endpoint requires POST");
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new WeldallAuthError("invalid_request", "form content type required");
  }
  try {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 64_000)
      throw new WeldallAuthError("invalid_request", "form is too large");
    const raw = await request.clone().text();
    if (new TextEncoder().encode(raw).byteLength > 64_000)
      throw new WeldallAuthError("invalid_request", "form is too large");
    const parameters = new URLSearchParams(raw);
    const form = new FormData();
    for (const [name, value] of parameters) form.append(name, value);
    return form;
  } catch (error) {
    if (error instanceof WeldallAuthError) throw error;
    throw new WeldallAuthError("invalid_request", "invalid form body");
  }
}

const findBinding = (token: string) =>
  db.oAuthDeviceRefreshBinding.findUnique({ where: { tokenHash: hash(token) } });

async function validateBoundProof(
  request: Request,
  binding?: OAuthDeviceRefreshBinding | null,
  url = WELDALL_TOKEN_ENDPOINT,
) {
  const proof = request.headers.get("dpop");
  if (!proof) throw new WeldallAuthError("invalid_dpop_proof");
  return verifyStrictDpop(proof, {
    method: "POST",
    url,
    replay,
    ...(binding ? { expectedJkt: binding.dpopJkt } : {}),
  });
}

async function exchange(
  request: Request,
  form: FormData,
  audit: ExchangeAuditContext,
  auditWriter: AuditWriter,
) {
  if (requiredString(form, "client_id") !== WELDALL_CLIENT_ID) {
    throw new WeldallAuthError("invalid_client");
  }
  audit.actorId = WELDALL_CLIENT_ID;
  audit.actorType = "oauth_client";
  audit.clientId = WELDALL_CLIENT_ID;
  if (
    requiredString(form, "requested_token_type") !== ID_JAG_TOKEN_TYPE ||
    requiredString(form, "subject_token_type") !== REFRESH_TOKEN_TYPE
  ) {
    throw new WeldallAuthError("invalid_target");
  }
  const audience = requiredString(form, "audience");
  const resourceIdentifier = requiredString(form, "resource");
  const subject = requiredString(form, "subject_token");
  const tokenHash = hash(subject);
  const [binding, providerToken] = await Promise.all([
    findBinding(subject),
    db.oauthRefreshToken.findUnique({ where: { token: tokenHash } }),
  ]);
  const providerJkt = confirmationJkt(providerToken?.confirmation);
  const now = new Date();
  const providerReuseSignal =
    binding &&
    providerToken?.rotatedAt &&
    providerToken.clientId === binding.clientId &&
    providerToken.userId === binding.userId &&
    !providerToken.revoked &&
    providerToken.expiresAt > now &&
    typeof providerJkt === "string" &&
    safeEqual(providerJkt, binding.dpopJkt);
  if (
    binding &&
    binding.clientId === WELDALL_CLIENT_ID &&
    !binding.revokedAt &&
    binding.expiresAt > now &&
    (binding.rotatedAt || providerReuseSignal)
  ) {
    audit.actorId = binding.userId;
    audit.actorType = "user";
    await validateBoundProof(request, binding);
    await db.oAuthDeviceRefreshBinding.updateMany({
      where: { familyId: binding.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new WeldallAuthError(
      "invalid_grant",
      "refresh token reuse detected",
      400,
      [],
      "replay_detected",
    );
  }
  if (
    !binding ||
    binding.clientId !== WELDALL_CLIENT_ID ||
    binding.revokedAt ||
    binding.expiresAt <= now ||
    !providerToken ||
    providerToken.clientId !== binding.clientId ||
    providerToken.userId !== binding.userId ||
    providerToken.revoked ||
    providerToken.rotatedAt ||
    providerToken.expiresAt <= now ||
    typeof providerJkt !== "string" ||
    !safeEqual(providerJkt, binding.dpopJkt)
  ) {
    throw new WeldallAuthError("invalid_grant");
  }
  audit.actorId = binding.userId;
  audit.actorType = "user";
  await validateBoundProof(request, binding);
  const user = await db.user.findUnique({ where: { id: binding.userId } });
  if (!user?.emailVerified) throw new WeldallAuthError("invalid_grant");
  const email = user.email.trim().toLowerCase();
  audit.actorEmail = email;
  const decision = await exchangePolicyRequiringSystemScopeFor({
    email: user.email,
    resourceIdentifier,
    authorizationServer: audience,
    requiredSystemScope: LOGIN_SCOPE_KEY,
  });
  if (!decision.authorized) throw new WeldallAuthError("invalid_grant");
  const policy = decision.policy;
  if (!policy) throw new WeldallAuthError("invalid_target");
  const scopes = [...new Set(requiredString(form, "scope").split(" ").filter(Boolean))].sort();
  if (
    !scopes.length ||
    scopes.some(
      (scope) => !policy.supportedScopes.includes(scope) || !policy.grantedScopes.includes(scope),
    )
  ) {
    throw new WeldallAuthError("invalid_scope");
  }
  const signingKey = await getWeldallSigningKey();
  const accessToken = await issueIdJag({
    issuer: WELDALL_ISSUER,
    subject: user.id,
    email,
    audience: policy.authorizationServer,
    clientId: policy.downstreamClientId,
    resource: policy.resourceIdentifier,
    scopes,
    jkt: binding.dpopJkt,
    kid: signingKey.kid,
    privateJwk: signingKey.privateJwk,
  });
  const claims = decodeJwt(accessToken);
  if (
    typeof claims.jti !== "string" ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp)
  ) {
    throw new Error("ID-JAG signer returned invalid audit claims");
  }
  try {
    await auditWriter.write({
      eventType: "id_jag.issued",
      actorType: "user",
      actorId: user.id,
      actorEmail: audit.actorEmail,
      clientId: WELDALL_CLIENT_ID,
      requestId: audit.requestId,
      ...(audit.correlationId ? { correlationId: audit.correlationId } : {}),
      deduplicationKey: auditDeduplicationKey(audit, "id_jag.issued"),
      outcome: "success",
      subjectType: "id_jag",
      subjectId: claims.jti,
      metadata: {
        audience: policy.authorizationServer,
        resource: policy.resourceIdentifier,
        requestedScopes: audit.requestedScopes,
        grantedScopes: scopes,
        targetClientId: policy.downstreamClientId,
        jti: claims.jti,
        issuedAt: new Date((claims.iat as number) * 1_000).toISOString(),
        expiresAt: new Date((claims.exp as number) * 1_000).toISOString(),
        kid: signingKey.kid,
      },
    });
  } catch {
    throw new WeldallAuthError("server_error", "audit store unavailable", 500);
  }
  return Response.json(
    {
      access_token: accessToken,
      issued_token_type: ID_JAG_TOKEN_TYPE,
      token_type: "N_A",
      expires_in: 300,
      scope: scopes.join(" "),
    },
    { headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );
}

function createExchangeAuditContext(request: Request, form: FormData): ExchangeAuditContext {
  const identifiers = auditRequestIdentifiers(request);
  const rawScope = safeAuditString(form.get("scope"), 16_100);
  const requestedScopes = rawScope
    ? [...new Set(rawScope.split(" ").filter((scope) => scope.length > 0 && scope.length <= 160))]
        .sort()
        .slice(0, 100)
    : [];
  return {
    ...identifiers,
    actorId: "anonymous",
    actorType: "anonymous",
    audience: safeAuditString(form.get("audience"), 2_000),
    resource: safeAuditString(form.get("resource"), 2_000),
    requestedScopes,
  };
}

async function auditExchangeFailure(
  audit: ExchangeAuditContext,
  error: unknown,
  auditWriter: AuditWriter,
): Promise<void> {
  const failed = !(error instanceof WeldallAuthError) || error.status >= 500;
  const reasonCode = auditReasonCode(error);
  try {
    await auditWriter.write({
      eventType: failed ? "id_jag.failed" : "id_jag.denied",
      actorType: audit.actorType,
      actorId: audit.actorId,
      ...(audit.actorEmail ? { actorEmail: audit.actorEmail } : {}),
      ...(audit.clientId ? { clientId: audit.clientId } : {}),
      requestId: audit.requestId,
      ...(audit.correlationId ? { correlationId: audit.correlationId } : {}),
      outcome: failed ? "failed" : "denied",
      reasonCode,
      ...(audit.resource ? { subjectType: "resource", subjectId: audit.resource } : {}),
      metadata: {
        audience: audit.audience,
        resource: audit.resource,
        requestedScopes: audit.requestedScopes,
      },
    });
  } catch (auditError) {
    logger.error(
      { event: "audit.id_jag.write_failed", error: errorForLog(auditError) },
      "ID-JAG audit write failed",
    );
  }
}

function auditDeduplicationKey(audit: ExchangeAuditContext, eventType: AuditEventType): string {
  return createHash("sha256")
    .update(`${audit.actorType}\0${audit.actorId}\0${audit.requestId}\0${eventType}`, "utf8")
    .digest("base64url");
}

function auditReasonCode(error: unknown): AuditReasonCode {
  if (!(error instanceof WeldallAuthError)) return "internal_error";
  if (error.status >= 500)
    return error.message === "audit store unavailable"
      ? "audit_store_unavailable"
      : "internal_error";
  if (error.reason === "replay_detected") return "replay_detected";
  if (error.code === "invalid_client") return "invalid_client";
  if (error.code === "invalid_target") return "invalid_resource";
  if (error.code === "invalid_scope") return "scope_not_granted";
  if (error.code === "invalid_dpop_proof") return "invalid_dpop_proof";
  if (error.code === "invalid_grant") return "invalid_grant";
  return "invalid_request";
}

function safeAuditString(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export function tokenFacade(request: Request) {
  return tokenFacadeWithAuditWriter(request, prismaAuditWriter);
}

export async function tokenFacadeWithAuditWriter(request: Request, auditWriter: AuditWriter) {
  let exchangeAudit: ExchangeAuditContext | undefined;
  let machineAudit: ReturnType<typeof machineAuditContext> | undefined;
  try {
    const form = await oauthForm(request);
    const grantTypeValue = form.get("grant_type");
    if (grantTypeValue === TOKEN_EXCHANGE_GRANT) {
      exchangeAudit = createExchangeAuditContext(request, form);
    } else if (grantTypeValue === "client_credentials") {
      machineAudit = machineAuditContext(request, form);
    }
    rejectDuplicateParameters(form);
    const grantType = requiredString(form, "grant_type");
    if (grantType === TOKEN_EXCHANGE_GRANT) {
      return await exchange(request, form, exchangeAudit!, auditWriter);
    }
    if (grantType === "client_credentials") {
      return await issueMachineToken(request, form, machineAudit!, auditWriter, replay);
    }

    let previous: OAuthDeviceRefreshBinding | null = null;
    let verifiedJkt: string | undefined;
    if (grantType === "refresh_token") {
      previous = await findBinding(requiredString(form, "refresh_token"));
      if (!previous || previous.revokedAt || previous.expiresAt <= new Date())
        throw new WeldallAuthError("invalid_grant");
      if (previous.rotatedAt) {
        await db.oAuthDeviceRefreshBinding.updateMany({
          where: { familyId: previous.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        throw new WeldallAuthError(
          "invalid_grant",
          "refresh token reuse detected",
          400,
          [],
          "replay_detected",
        );
      }
      verifiedJkt = (await validateBoundProof(request, previous)).jkt;
    }

    // Better Auth validates DPoP against request.url. Canonicalize the URL because
    // Next.js may expose Caddy's internal upstream URL instead of the public endpoint.
    const response = await auth.handler(new Request(WELDALL_TOKEN_ENDPOINT, request));
    if (grantType === "refresh_token" && previous && !response.ok) {
      const providerError = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown } | null;
      if (providerError?.error === "invalid_grant")
        await db.oAuthDeviceRefreshBinding.updateMany({
          where: { familyId: previous.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      return response;
    }
    if (!response.ok || (grantType !== "authorization_code" && grantType !== "refresh_token"))
      return response;

    const data = (await response.clone().json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
    };
    if (!data.refresh_token || !data.access_token || data.token_type !== "DPoP")
      throw new WeldallAuthError("server_error", "invalid provider token response", 500);

    if (!verifiedJkt) verifiedJkt = (await validateBoundProof(request)).jkt;
    const signingKey = await getWeldallSigningKey();
    const payload = await verifyEs256(data.access_token, {
      issuer: WELDALL_ISSUER,
      audience: WELDALL_RESOURCE,
      kid: signingKey.kid,
      publicJwk: signingKey.publicJwk,
      typ: "at+jwt",
      errorCode: "server_error",
      errorStatus: 500,
    });
    const audiences =
      typeof payload.aud === "string"
        ? [payload.aud]
        : Array.isArray(payload.aud) &&
            payload.aud.every((audience) => typeof audience === "string")
          ? payload.aud
          : [];
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      !audiences.includes(WELDALL_RESOURCE) ||
      new Set(audiences).size !== audiences.length ||
      payload.client_id !== WELDALL_CLIENT_ID ||
      (audiences.length > 1 && payload.azp !== WELDALL_CLIENT_ID) ||
      typeof (payload.cnf as { jkt?: unknown } | undefined)?.jkt !== "string" ||
      !safeEqual((payload.cnf as { jkt: string }).jkt, verifiedJkt)
    )
      throw new WeldallAuthError("server_error", "provider returned an unbound token", 500);
    if (!(await hasLoginScopeForUserId(payload.sub))) {
      throw new WeldallAuthError("invalid_grant");
    }

    const tokenHash = hash(data.refresh_token);
    if (previous) {
      await db.$transaction([
        db.oAuthDeviceRefreshBinding.update({
          where: { id: previous.id },
          data: { rotatedAt: new Date(), replacementHash: tokenHash },
        }),
        db.oAuthDeviceRefreshBinding.create({
          data: {
            tokenHash,
            familyId: previous.familyId,
            clientId: previous.clientId,
            userId: previous.userId,
            dpopJkt: previous.dpopJkt,
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
          },
        }),
      ]);
      const familyWasRevoked = await db.oAuthDeviceRefreshBinding.findFirst({
        where: { familyId: previous.familyId, revokedAt: { not: null } },
        select: { id: true },
      });
      if (familyWasRevoked)
        await db.oAuthDeviceRefreshBinding.updateMany({
          where: { familyId: previous.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
    } else {
      await db.oAuthDeviceRefreshBinding.create({
        data: {
          tokenHash,
          familyId: randomUUID(),
          clientId: WELDALL_CLIENT_ID,
          userId: payload.sub,
          dpopJkt: verifiedJkt,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
      });
    }
    return response;
  } catch (error) {
    if (exchangeAudit) await auditExchangeFailure(exchangeAudit, error, auditWriter);
    if (machineAudit) await auditMachineFailure(machineAudit, error, auditWriter);
    return loggedOauthErrorResponse(error);
  }
}

export async function revocationFacade(request: Request) {
  try {
    const form = await oauthForm(request);
    rejectDuplicateParameters(form);
    const binding = await findBinding(requiredString(form, "token"));
    if (!binding || binding.revokedAt)
      return new Response(null, {
        status: 200,
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      });
    await validateBoundProof(request, binding, WELDALL_REVOCATION_ENDPOINT);
    const response = await auth.handler(new Request(WELDALL_REVOCATION_ENDPOINT, request));
    if (response.ok)
      await db.oAuthDeviceRefreshBinding.updateMany({
        where: { familyId: binding.familyId },
        data: { revokedAt: new Date() },
      });
    return response;
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}
