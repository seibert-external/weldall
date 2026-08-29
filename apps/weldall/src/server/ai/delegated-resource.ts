import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import {
  createDpopProof,
  generateEs256KeyPair,
  issueIdJag,
  JWT_DPOP_GRANT,
  normalizeRequestTarget,
} from "@weldall/sdk";
import { db, LOGIN_SCOPE_KEY, Prisma } from "@weldall/db";
import { prismaAuditWriter } from "../audit/service";
import type { RequestIdentifiers } from "../observability/http";
import { logger } from "../observability/logger";
import { WELDALL_ISSUER } from "../oauth/constants";
import { getWeldallSigningKey } from "../oauth/jwt";
import { delegatedRequestPolicyFor } from "../policy/resources";

const DOWNSTREAM_TIMEOUT_MS = 15_000;
const MAX_TOKEN_RESPONSE_BYTES = 32_000;
const MAX_RESOURCE_RESPONSE_BYTES = 128_000;
const MAX_REQUEST_BODY_BYTES = 64_000;
const WEB_CHAT_CLIENT_ID = "weldall-web-chat";

export interface ChatPrincipal {
  id: string;
  email: string;
  name: string;
}

export interface DelegatedResourceRequest {
  url: string;
  method: "GET" | "POST";
  scopes: string[];
  json?: unknown;
  signal?: AbortSignal;
  toolCallId: string;
  requestIdentifiers: RequestIdentifiers;
  allowedResourceKeys: string[];
  skillSlug: string;
}

export interface DelegatedResourceResponse {
  resource: { key: string; name: string };
  url: string;
  method: "GET" | "POST";
  status: number;
  ok: boolean;
  data: unknown;
  responseBytes: number;
}

export async function delegatedResourceRequest(
  principal: ChatPrincipal,
  input: DelegatedResourceRequest,
): Promise<DelegatedResourceResponse> {
  if (input.method === "GET" && input.json !== undefined) {
    throw new Error("GET requests cannot include a JSON body.");
  }

  const user = await db.user.findUnique({
    where: { id: principal.id },
    select: { email: true, emailVerified: true },
  });
  const email = user?.email.trim().toLowerCase();
  if (!user?.emailVerified || !email || email !== principal.email.trim().toLowerCase()) {
    throw new Error("The signed-in Weldall identity is no longer valid.");
  }

  const target = normalizeRequestTarget(input.url);
  const decision = await delegatedRequestPolicyFor({
    email,
    target,
    requiredSystemScope: LOGIN_SCOPE_KEY,
  });
  if (!decision.authorized) {
    throw new Error("The weldall:login scope is required to use Weldall chat tools.");
  }
  if (decision.matches.length !== 1) {
    throw new Error(
      decision.matches.length === 0
        ? "The request URL is not registered for this Weldall account."
        : "The request URL matches more than one Weldall resource.",
    );
  }
  const resource = decision.matches[0]!;
  if (!input.allowedResourceKeys.includes(resource.key)) {
    throw new Error("The selected skill does not allow requests to this resource.");
  }
  const scopes = [...new Set(input.scopes)].sort();
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        !resource.supportedScopes.includes(scope) || !resource.grantedScopes.includes(scope),
    )
  ) {
    throw new Error("One or more requested scopes are not granted for this resource.");
  }

  const body = input.json === undefined ? undefined : JSON.stringify(input.json);
  if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
    throw new Error("The JSON request body is too large.");
  }

  const auditTarget = `${target.origin}${target.pathname}`;
  const requestMetadata = {
    toolCallId: input.toolCallId,
    skillSlug: input.skillSlug,
    resourceKey: resource.key,
    method: input.method,
    target: auditTarget,
    querySha256: target.search ? sha256(target.search) : null,
    scopes,
    requestBodySha256: body === undefined ? null : sha256(body),
    requestBodyBytes: body === undefined ? 0 : Buffer.byteLength(body, "utf8"),
  };
  try {
    await prismaAuditWriter.write({
      eventType: "chat_tool.requested",
      actorType: "user",
      actorId: principal.id,
      actorEmail: email,
      clientId: WEB_CHAT_CLIENT_ID,
      ...input.requestIdentifiers,
      ...(input.method === "POST"
        ? { deduplicationKey: sha256(`chat-tool\0${principal.id}\0${input.toolCallId}`) }
        : {}),
      outcome: "success",
      subjectType: "resource",
      subjectId: resource.key,
      metadata: requestMetadata,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new Error("This approved Weldall request has already been used.");
    }
    throw error;
  }

  let downstreamStatus: number | null = null;
  let responseBytes: number | null = null;
  try {
    const dpopKey = await generateEs256KeyPair();
    const signingKey = await getWeldallSigningKey();
    const assertion = await issueIdJag({
      issuer: WELDALL_ISSUER,
      subject: principal.id,
      email,
      audience: resource.authorizationServer,
      clientId: resource.downstreamClientId,
      resource: resource.resourceIdentifier,
      scopes,
      jkt: dpopKey.jkt,
      kid: signingKey.kid,
      privateJwk: signingKey.privateJwk,
    });
    const claims = decodeJwt(assertion);
    if (
      typeof claims.jti !== "string" ||
      !Number.isInteger(claims.iat) ||
      !Number.isInteger(claims.exp)
    ) {
      throw new Error("Weldall produced an invalid delegated assertion.");
    }

    await prismaAuditWriter.write({
      eventType: "id_jag.issued",
      actorType: "user",
      actorId: principal.id,
      actorEmail: email,
      clientId: WEB_CHAT_CLIENT_ID,
      ...input.requestIdentifiers,
      outcome: "success",
      subjectType: "id_jag",
      subjectId: claims.jti,
      metadata: {
        audience: resource.authorizationServer,
        resource: resource.resourceIdentifier,
        requestedScopes: scopes,
        grantedScopes: scopes,
        targetClientId: resource.downstreamClientId,
        jti: claims.jti,
        issuedAt: new Date((claims.iat as number) * 1_000).toISOString(),
        expiresAt: new Date((claims.exp as number) * 1_000).toISOString(),
        kid: signingKey.kid,
      },
    });

    const downstreamTokenEndpoint = `${resource.authorizationServer}/oauth/token`;
    const tokenProof = await createDpopProof({
      method: "POST",
      url: downstreamTokenEndpoint,
      privateJwk: dpopKey.privateJwk,
      publicJwk: dpopKey.publicJwk,
    });
    const tokenResponse = await fetch(downstreamTokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: tokenProof },
      body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
      redirect: "error",
      signal: requestSignal(input.signal),
    });
    const token = await readBoundedJson(tokenResponse, MAX_TOKEN_RESPONSE_BYTES);
    if (
      !tokenResponse.ok ||
      !isRecord(token) ||
      token.token_type !== "DPoP" ||
      typeof token.access_token !== "string" ||
      !token.access_token ||
      typeof token.expires_in !== "number" ||
      !Number.isInteger(token.expires_in) ||
      token.expires_in < 1 ||
      token.expires_in > 3_600
    ) {
      throw new Error(`The downstream token request failed with HTTP ${tokenResponse.status}.`);
    }

    const accessToken = token.access_token;
    const proof = await createDpopProof({
      method: input.method,
      url: target.toString(),
      privateJwk: dpopKey.privateJwk,
      publicJwk: dpopKey.publicJwk,
      accessToken,
    });
    const response = await fetch(target, {
      method: input.method,
      headers: {
        accept: "application/json",
        authorization: `DPoP ${accessToken}`,
        dpop: proof,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: requestSignal(input.signal),
    });
    downstreamStatus = response.status;
    const result = await readBoundedJsonWithSize(response, MAX_RESOURCE_RESPONSE_BYTES);
    responseBytes = result.bytes;

    await writeToolResultAudit({
      eventType: "chat_tool.succeeded",
      principal: { ...principal, email },
      input,
      resourceKey: resource.key,
      metadata: { ...requestMetadata, downstreamStatus, responseBytes },
      outcome: "success",
    });
    logger.info(
      {
        event: "chat.tool.resource_request.completed",
        toolCallId: input.toolCallId,
        resourceKey: resource.key,
        target: auditTarget,
        requestMethod: input.method,
        requestedScopes: scopes,
        status: response.status,
        responseBytes,
      },
      "Chat resource request completed",
    );

    return {
      resource: { key: resource.key, name: resource.name },
      url: target.toString(),
      method: input.method,
      status: response.status,
      ok: response.ok,
      data: result.value,
      responseBytes,
    };
  } catch (error) {
    await writeToolResultAudit({
      eventType: "chat_tool.failed",
      principal: { ...principal, email },
      input,
      resourceKey: resource.key,
      metadata: { ...requestMetadata, downstreamStatus, responseBytes },
      outcome: "failed",
      reasonCode: "internal_error",
    }).catch((auditError) => {
      logger.error(
        { event: "chat.tool.audit.failed", error: String(auditError) },
        "Failed to audit chat tool failure",
      );
    });
    throw error;
  }
}

async function writeToolResultAudit(input: {
  eventType: "chat_tool.succeeded" | "chat_tool.failed";
  principal: ChatPrincipal;
  input: DelegatedResourceRequest;
  resourceKey: string;
  metadata: Record<string, unknown>;
  outcome: "success" | "failed";
  reasonCode?: "internal_error";
}) {
  await prismaAuditWriter.write({
    eventType: input.eventType,
    actorType: "user",
    actorId: input.principal.id,
    actorEmail: input.principal.email,
    clientId: WEB_CHAT_CLIENT_ID,
    ...input.input.requestIdentifiers,
    outcome: input.outcome,
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    subjectType: "resource",
    subjectId: input.resourceKey,
    metadata: input.metadata,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  return (await readBoundedJsonWithSize(response, maximumBytes)).value;
}

async function readBoundedJsonWithSize(
  response: Response,
  maximumBytes: number,
): Promise<{ value: unknown; bytes: number }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("The downstream JSON response is too large.");
  }

  if (!response.body) return { value: null, bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("The downstream JSON response is too large.");
    }
    chunks.push(value);
  }
  if (bytes === 0) return { value: null, bytes };

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new Error("The downstream response is not JSON.");
  }

  const text = new TextDecoder().decode(concatenate(chunks, bytes));
  try {
    return { value: JSON.parse(text) as unknown, bytes };
  } catch {
    throw new Error("The downstream service returned invalid JSON.");
  }
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
