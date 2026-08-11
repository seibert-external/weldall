import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db } from "@weldall/db";
import {
  PRIVATE_KEY_JWT_ASSERTION_TYPE,
  MACHINE_TOKEN_LIFETIME_SECONDS,
  MACHINE_TOKEN_TYP,
  WeldallAuthError,
  consumeReplay,
  verifyStrictDpop,
  type ReplayStore,
} from "@weldall/sdk";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jose";
import type { AuditReasonCode } from "../../lib/audit";
import { auditRequestIdentifiers, type AuditWriter } from "../audit/service";
import { WELDALL_ISSUER, WELDALL_TOKEN_ENDPOINT } from "./constants";
import { signWeldallJwt } from "./jwt";

const safeId = /^[A-Za-z0-9._:-]{1,128}$/;
const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]{1,160}$/;

type Context = ReturnType<typeof auditRequestIdentifiers> & {
  actorId: string;
  actorType: "anonymous" | "machine";
  clientId: string | null;
  kid: string | null;
  audience: string | null;
  requestedScopes: string[];
};

function required(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value)
    throw new WeldallAuthError("invalid_request", `missing ${name}`);
  return value;
}

export function machineAuditContext(request: Request, form: FormData): Context {
  const rawClient = form.get("client_id");
  const rawResource = form.get("resource");
  const rawScope = form.get("scope");
  return {
    ...auditRequestIdentifiers(request),
    actorId: "anonymous",
    actorType: "anonymous",
    clientId: typeof rawClient === "string" && safeId.test(rawClient) ? rawClient : null,
    kid: null,
    audience: safeAuditString(rawResource, 2_000),
    requestedScopes:
      typeof rawScope === "string"
        ? [...new Set(rawScope.split(" ").filter((scope) => scopePattern.test(scope)))]
            .sort()
            .slice(0, 100)
        : [],
  };
}

function safeAuditString(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

export async function issueMachineToken(
  request: Request,
  form: FormData,
  context: Context,
  auditWriter: AuditWriter,
  replay: ReplayStore,
): Promise<Response> {
  const allowedParameters = new Set([
    "grant_type",
    "client_id",
    "client_assertion_type",
    "client_assertion",
    "resource",
    "scope",
  ]);
  if ([...form.keys()].some((name) => !allowedParameters.has(name)))
    throw new WeldallAuthError("invalid_request", "unsupported OAuth parameter");
  const clientId = required(form, "client_id");
  if (!safeId.test(clientId) || clientId === "weldall-cli")
    throw new WeldallAuthError("invalid_client");
  if (required(form, "client_assertion_type") !== PRIVATE_KEY_JWT_ASSERTION_TYPE)
    throw new WeldallAuthError("invalid_client");
  const assertion = required(form, "client_assertion");
  const resourceIdentifier = required(form, "resource");
  const scopes = [...new Set(required(form, "scope").split(" ").filter(Boolean))].sort();
  if (!scopes.length || scopes.some((scope) => !scopePattern.test(scope)))
    throw new WeldallAuthError("invalid_scope");

  let kid: string;
  try {
    const header = decodeProtectedHeader(assertion);
    if (
      header.alg !== "ES256" ||
      header.typ !== "JWT" ||
      header.crit ||
      typeof header.kid !== "string" ||
      !safeId.test(header.kid)
    )
      throw new Error("header");
    kid = header.kid;
  } catch {
    throw new WeldallAuthError("invalid_client");
  }

  // Consume process-local replay markers before opening an interactive transaction.
  // This preserves them across later policy denials, audit failures, and rollbacks.
  const authenticatedClient = await db.machineClient.findUnique({
    where: { clientId },
    include: { keys: { where: { kid } } },
  });
  const authenticatedKey = authenticatedClient?.keys[0];
  if (
    !authenticatedClient ||
    !authenticatedClient.enabled ||
    authenticatedClient.deactivatedAt ||
    !authenticatedKey
  )
    throw new WeldallAuthError("invalid_client");

  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(
      assertion,
      await importJWK(authenticatedKey.publicJwk as JWK, "ES256"),
      {
        algorithms: ["ES256"],
        issuer: clientId,
        subject: clientId,
        audience: WELDALL_TOKEN_ENDPOINT,
        requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti"],
        maxTokenAge: "60s",
        clockTolerance: 5,
      },
    ));
  } catch {
    throw new WeldallAuthError("invalid_client");
  }
  if (
    claims.aud !== WELDALL_TOKEN_ENDPOINT ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    (claims.exp as number) <= (claims.iat as number) ||
    (claims.exp as number) - (claims.iat as number) > 60 ||
    typeof claims.jti !== "string" ||
    !claims.jti ||
    claims.jti.length > 128 ||
    authenticatedKey.revokedAt !== null
  )
    throw new WeldallAuthError("invalid_client");

  context.actorId = authenticatedClient.clientId;
  context.actorType = "machine";
  context.clientId = authenticatedClient.clientId;
  context.kid = authenticatedKey.kid;

  const proof = request.headers.get("dpop");
  if (!proof || proof.includes(",")) throw new WeldallAuthError("invalid_dpop_proof");
  await verifyStrictDpop(proof, {
    method: "POST",
    url: WELDALL_TOKEN_ENDPOINT,
    replay,
    expectedJkt: authenticatedKey.thumbprint,
  });
  await consumeReplay(
    replay,
    "machine-assertion",
    `${authenticatedClient.clientId}:${claims.jti}`,
    new Date(((claims.exp as number) + 6) * 1_000),
    { code: "invalid_client", message: "client assertion was already used" },
  );

  return db.$transaction(async (tx) => {
    // These row locks establish a total order with client, key, access-policy, and resource
    // lifecycle writes. If a lifecycle change commits first, the state below is read after it;
    // if issuance locks first, that token commits before the lifecycle change can commit.
    const lockedIdentity = await tx.$queryRaw<Array<{ clientId: string; keyId: string }>>`
      SELECT c."id" AS "clientId", k."id" AS "keyId"
      FROM "MachineClient" c
      JOIN "MachineClientKey" k ON k."machineClientId" = c."id"
      WHERE c."clientId" = ${clientId} AND k."kid" = ${kid}
      FOR SHARE OF c, k
    `;
    if (lockedIdentity.length !== 1) throw new WeldallAuthError("invalid_client");
    const locked = lockedIdentity[0]!;

    // Lock the requested resource before its allowlist row. Resource deletion and supported-scope
    // replacement use the same resource lock, while access replacement must first update the
    // already share-locked client row.
    const lockedResources = await tx.$queryRaw<Array<{ resourceId: string }>>`
      SELECT r."id" AS "resourceId"
      FROM "DownstreamResource" r
      WHERE r."resourceIdentifier" = ${resourceIdentifier}
      FOR SHARE OF r
    `;
    if (lockedResources.length !== 1) throw new WeldallAuthError("invalid_target");
    const lockedResource = lockedResources[0]!;

    const lockedAccess = await tx.$queryRaw<Array<{ resourceId: string }>>`
      SELECT a."resourceId"
      FROM "MachineAllowedResource" a
      WHERE a."machineClientId" = ${locked.clientId}
        AND a."resourceId" = ${lockedResource.resourceId}
      FOR SHARE OF a
    `;
    // A missing allowlist row locks nothing. Reject from this statement snapshot rather than
    // allowing a later READ COMMITTED query to observe a newly selected resource phantom.
    if (lockedAccess.length !== 1) throw new WeldallAuthError("invalid_target");

    const client = await tx.machineClient.findUnique({
      where: { id: locked.clientId },
      include: {
        keys: { where: { id: locked.keyId } },
        allowedResources: {
          where: { resourceId: lockedResource.resourceId },
          include: { resource: { include: { scopes: { include: { scope: true } } } } },
        },
        allowedScopes: { include: { scope: true } },
      },
    });
    const key = client?.keys[0];
    if (
      !client ||
      !client.enabled ||
      client.deactivatedAt ||
      !key ||
      key.id !== authenticatedKey.id ||
      key.thumbprint !== authenticatedKey.thumbprint ||
      !isDeepStrictEqual(key.publicJwk, authenticatedKey.publicJwk) ||
      key.revokedAt !== null
    )
      throw new WeldallAuthError("invalid_client");

    const allowedResource = client.allowedResources[0];
    if (
      !allowedResource ||
      !allowedResource.resource.enabled ||
      allowedResource.resource.resourceIdentifier !== resourceIdentifier
    )
      throw new WeldallAuthError("invalid_target");
    const allowedScopes = new Set(client.allowedScopes.map(({ scope }) => scope.key));
    const supportedScopes = new Set(allowedResource.resource.scopes.map(({ scope }) => scope.key));
    if (scopes.some((scope) => !allowedScopes.has(scope) || !supportedScopes.has(scope)))
      throw new WeldallAuthError("invalid_scope");

    const issuedAt = Math.floor(Date.now() / 1_000);
    const expiresAt = issuedAt + MACHINE_TOKEN_LIFETIME_SECONDS;
    const jti = randomUUID();
    const token = await signWeldallJwt(
      {
        iss: WELDALL_ISSUER,
        sub: `machine:${client.clientId}`,
        client_id: client.clientId,
        azp: client.clientId,
        aud: allowedResource.resource.resourceIdentifier,
        scope: scopes.join(" "),
        identity_type: "machine",
        token_type: "machine",
        cnf: { jkt: key.thumbprint },
        iat: issuedAt,
        exp: expiresAt,
        jti,
      },
      { typ: MACHINE_TOKEN_TYP },
    );
    try {
      await auditWriter.write(
        {
          eventType: "machine_token.issued",
          actorType: "machine",
          actorId: client.clientId,
          clientId: client.clientId,
          requestId: context.requestId,
          ...(context.correlationId ? { correlationId: context.correlationId } : {}),
          outcome: "success",
          subjectType: "machine_access_token",
          subjectId: jti,
          metadata: {
            clientId: client.clientId,
            kid: key.kid,
            audience: allowedResource.resource.resourceIdentifier,
            requestedScopes: context.requestedScopes,
            grantedScopes: scopes,
            jti,
            issuedAt: new Date(issuedAt * 1_000).toISOString(),
            expiresAt: new Date(expiresAt * 1_000).toISOString(),
          },
        },
        tx,
      );
    } catch {
      throw new WeldallAuthError("server_error", "audit store unavailable", 500);
    }
    return Response.json(
      {
        access_token: token,
        token_type: "DPoP",
        expires_in: MACHINE_TOKEN_LIFETIME_SECONDS,
        scope: scopes.join(" "),
      },
      { headers: { "cache-control": "no-store", pragma: "no-cache" } },
    );
  });
}

export async function auditMachineFailure(
  context: Context,
  error: unknown,
  auditWriter: AuditWriter,
): Promise<void> {
  const failed = !(error instanceof WeldallAuthError) || error.status >= 500;
  try {
    await auditWriter.write({
      eventType: failed ? "machine_token.failed" : "machine_token.denied",
      actorType: context.actorType,
      actorId: context.actorId,
      ...(context.actorType === "machine" && context.clientId
        ? { clientId: context.clientId }
        : {}),
      requestId: context.requestId,
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      outcome: failed ? "failed" : "denied",
      reasonCode: reason(error),
      ...(context.audience ? { subjectType: "resource", subjectId: context.audience } : {}),
      metadata: {
        clientId: context.clientId,
        kid: context.kid,
        audience: context.audience,
        requestedScopes: context.requestedScopes,
      },
    });
  } catch {
    console.error("Machine token audit write failed");
  }
}

function reason(error: unknown): AuditReasonCode {
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
  return "invalid_request";
}
