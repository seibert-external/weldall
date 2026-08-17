import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { db, Prisma } from "@weldall/db";
import { WeldallAuthError, verifyStrictDpop } from "@weldall/sdk";
import { hasLoginScopeForUserId } from "../auth/login-policy";
import { auditRequestIdentifiers, prismaAuditWriter, type AuditWriter } from "../audit/service";
import { WELDALL_ISSUER, WELDALL_TOKEN_ENDPOINT } from "./constants";
import {
  browserClientIdForResourceKey,
  browserOriginsForResource,
  lockBrowserResourceLifecycle,
  resolveEnabledBrowserResource,
} from "./browser-resources";
import { postgresReplayStore } from "./replay";

export const BROWSER_CONNECTION_TTL_SECONDS = 300;
export const BROWSER_CONNECTION_POLL_INTERVAL_SECONDS = 5;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ACTIVE_STATUSES = ["PENDING", "APPROVED", "ISSUING"] as const;
const GLOBAL_QUOTA_LOCK = 1_462_763_315;
const FORWARDED_SOURCE_HEADER = "x-forwarded-for";
const PROXY_ATTESTATION_HEADER = "x-weldall-proxy-attestation";

export const BROWSER_PENDING_QUOTAS = {
  global: 10_000,
  resource: 1_000,
  origin: 1_000,
  client: 1_000,
} as const;

type PendingRequest = Prisma.BrowserConnectionRequestGetPayload<{
  include: { resource: true; oauthClient: true; approvedByUser: true };
}>;

export type PendingBrowserContext = {
  requestId: string;
  userCode: string;
  origin: string;
  resource: { id: string; key: string; name: string; identifier: string };
  browserClientId: string;
  expiresAt: string;
  account: { id: string; email: string };
};

export type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

function secretHash(namespace: string, value: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET is required");
  return createHmac("sha256", secret).update(`${namespace}\0${value}`, "utf8").digest("base64url");
}

function deviceCodeHash(value: string): string {
  return secretHash("browser-device-code-v1", value);
}

function userCodeHash(value: string): string {
  return secretHash("browser-user-code-v1", value);
}

function rateKey(namespace: string, value: string): string {
  return `${namespace}:${secretHash(`browser-rate-${namespace}-v1`, value)}`;
}

function validProxyAttestation(request: Request): boolean {
  const expected = process.env.WELDALL_TRUSTED_PROXY_SECRET;
  const presented = request.headers.get(PROXY_ATTESTATION_HEADER);
  if (!expected || expected.length < 32 || !presented) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(presented));
}

/**
 * The edge must overwrite X-Forwarded-For and attach the deployment secret.
 * Without both, all callers share one fail-closed bucket rather than trusting a
 * forgeable client header. The secret is used only for constant-time comparison.
 */
function networkSource(request: Request): string {
  if (!validProxyAttestation(request)) return "untrusted-proxy-source";
  const forwarded = request.headers.get(FORWARDED_SOURCE_HEADER);
  const source = forwarded?.split(",").at(-1)?.trim();
  return source && source.length <= 100 && !/[\u0000-\u001f\u007f]/.test(source)
    ? source
    : "untrusted-proxy-source";
}

function exactRequestOrigin(request: Request): string {
  const raw = request.headers.get("origin");
  if (!raw || raw === "null") throw new WeldallAuthError("invalid_request", "Origin is required");
  try {
    const url = new URL(raw);
    if (
      url.origin !== raw ||
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("origin");
    return url.origin;
  } catch {
    throw new WeldallAuthError("invalid_request", "Origin is invalid");
  }
}

async function strictForm(request: Request): Promise<URLSearchParams> {
  if (request.method !== "POST") throw new WeldallAuthError("invalid_request", "POST is required");
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  )
    throw new WeldallAuthError("invalid_request", "form content type required");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 8_192)
    throw new WeldallAuthError("invalid_request", "form is too large");
  const raw = await request.clone().text();
  if (new TextEncoder().encode(raw).byteLength > 8_192)
    throw new WeldallAuthError("invalid_request", "form is too large");
  const form = new URLSearchParams(raw);
  const allowed = new Set(["client_id", "resource"]);
  for (const key of form.keys())
    if (!allowed.has(key)) throw new WeldallAuthError("invalid_request", "unexpected parameter");
  for (const key of allowed)
    if (form.getAll(key).length !== 1 || !form.get(key))
      throw new WeldallAuthError("invalid_request", `exactly one ${key} is required`);
  return form;
}

export async function parsePendingRequestBody(
  request: Request,
  decision: boolean,
): Promise<{ userCode: string; approve?: boolean }> {
  await consumeBrowserEntranceRateLimit(request, decision ? "decision" : "lookup");
  if (request.method !== "POST") throw new WeldallAuthError("invalid_request", "POST is required");
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new WeldallAuthError("invalid_request", "JSON content type required");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 2_048)
    throw new WeldallAuthError("invalid_request", "request is too large");
  const raw = await request.clone().text();
  if (new TextEncoder().encode(raw).byteLength > 2_048)
    throw new WeldallAuthError("invalid_request", "request is too large");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WeldallAuthError("invalid_request", "invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WeldallAuthError("invalid_request", "invalid body");
  const record = value as Record<string, unknown>;
  const expected = decision ? ["approve", "userCode"] : ["userCode"];
  if (
    Object.keys(record).sort().join("\0") !== expected.sort().join("\0") ||
    typeof record.userCode !== "string" ||
    (decision && typeof record.approve !== "boolean")
  )
    throw new WeldallAuthError("invalid_request", "invalid body");
  return {
    userCode: normalizeBrowserUserCode(record.userCode),
    ...(decision ? { approve: record.approve as boolean } : {}),
  };
}

export function normalizeBrowserUserCode(raw: string): string {
  const compact = raw.trim().toUpperCase().replaceAll(/[\s-]/g, "");
  if (
    compact.length !== 8 ||
    [...compact].some((character) => !USER_CODE_ALPHABET.includes(character))
  )
    throw new WeldallAuthError("invalid_request", "invalid connection code");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function generateUserCode(): string {
  let compact = "";
  while (compact.length < 8) {
    const value = randomBytes(1)[0]!;
    if (value < Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length)
      compact += USER_CODE_ALPHABET[value % USER_CODE_ALPHABET.length];
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

async function consumeRateLimits(
  tx: Prisma.TransactionClient,
  limits: readonly { key: string; maximum: number; windowSeconds: number }[],
  now: Date,
): Promise<void> {
  for (const limit of limits) {
    const expiresAt = new Date(now.getTime() + limit.windowSeconds * 1_000);
    const rows = await tx.$queryRaw<{ count: number }[]>`
      INSERT INTO "BrowserConnectionRateLimitBucket" ("key", "count", "windowStart", "expiresAt", "createdAt", "updatedAt")
      VALUES (${limit.key}, 1, ${now}, ${expiresAt}, ${now}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "BrowserConnectionRateLimitBucket"."expiresAt" <= ${now} THEN 1
          ELSE "BrowserConnectionRateLimitBucket"."count" + 1
        END,
        "windowStart" = CASE
          WHEN "BrowserConnectionRateLimitBucket"."expiresAt" <= ${now} THEN ${now}
          ELSE "BrowserConnectionRateLimitBucket"."windowStart"
        END,
        "expiresAt" = CASE
          WHEN "BrowserConnectionRateLimitBucket"."expiresAt" <= ${now} THEN ${expiresAt}
          ELSE "BrowserConnectionRateLimitBucket"."expiresAt"
        END,
        "updatedAt" = ${now}
      RETURNING "count"
    `;
    if ((rows[0]?.count ?? limit.maximum + 1) > limit.maximum)
      throw new WeldallAuthError("slow_down", "too many connection requests", 429);
  }
}

export async function consumeBrowserEntranceRateLimit(
  request: Request,
  operation: "start" | "lookup" | "decision" | "poll",
): Promise<void> {
  const maximum = operation === "start" ? 20 : operation === "poll" ? 300 : 60;
  const now = new Date();
  await db.$transaction((tx) =>
    consumeRateLimits(
      tx,
      [
        {
          key: rateKey(`${operation}-entrance-source`, networkSource(request)),
          maximum,
          windowSeconds: 300,
        },
      ],
      now,
    ),
  );
}

export function browserPendingQuotaExceeded(input: {
  global: number;
  resource: number;
  origin: number;
  client: number;
}): boolean {
  return (
    input.global >= BROWSER_PENDING_QUOTAS.global ||
    input.resource >= BROWSER_PENDING_QUOTAS.resource ||
    input.origin >= BROWSER_PENDING_QUOTAS.origin ||
    input.client >= BROWSER_PENDING_QUOTAS.client
  );
}

export async function auditBrowserConnectionFailure(
  request: Request,
  stage: "start" | "lookup" | "decision" | "poll" | "issuance" | "revocation",
  error: unknown,
  context: {
    requestId?: string | null;
    connectionId?: string | null;
    browserClientId?: string | null;
    origin?: string | null;
    resourceIdentifier?: string | null;
    dpopJkt?: string | null;
  } = {},
): Promise<void> {
  try {
    const now = new Date();
    const identifiers = auditRequestIdentifiers(request);
    await db.$transaction(async (tx) => {
      await consumeRateLimits(
        tx,
        [
          {
            key: rateKey(`failure-audit-${stage}`, networkSource(request)),
            maximum: 10,
            windowSeconds: 300,
          },
        ],
        now,
      );
      const reasonCode =
        error instanceof WeldallAuthError
          ? error.code === "invalid_client"
            ? "invalid_client"
            : error.code === "invalid_dpop_proof"
              ? "invalid_dpop_proof"
              : error.code === "slow_down"
                ? "rate_limited"
                : error.code === "invalid_grant"
                  ? "invalid_grant"
                  : "invalid_request"
          : "internal_error";
      await prismaAuditWriter.write(
        {
          eventType: "browser_connection.failed",
          actorType: "anonymous",
          actorId: `browser-${stage}`,
          ...identifiers,
          outcome: "failed",
          reasonCode,
          metadata: {
            stage,
            requestId: context.requestId ?? null,
            connectionId: context.connectionId ?? null,
            browserClientId: context.browserClientId ?? null,
            origin: context.origin ?? null,
            resourceIdentifier: context.resourceIdentifier ?? null,
            dpopJkt: context.dpopJkt ?? null,
          },
        },
        tx,
      );
    });
  } catch {
    // Failure auditing is deliberately bounded and must not replace the protocol error.
  }
}

export async function cleanupBrowserConnectionState(now = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    const expired = await tx.browserConnectionRequest.findMany({
      where: { status: { in: [...ACTIVE_STATUSES] }, expiresAt: { lte: now } },
      orderBy: { expiresAt: "asc" },
      take: 500,
      select: { id: true },
    });
    if (expired.length) {
      const ids = expired.map(({ id }) => id);
      await tx.browserConnectionIssuanceAttempt.updateMany({
        where: {
          requestId: { in: ids },
          status: { in: ["CLAIMED", "PROVIDER_ISSUED", "BINDING_CREATED"] },
        },
        data: { status: "FAILED", failureCode: "expired", failedAt: now },
      });
      await tx.browserConnectionRequest.updateMany({
        where: { id: { in: ids }, status: { in: [...ACTIVE_STATUSES] } },
        data: { status: "EXPIRED" },
      });
    }
    const old = await tx.browserConnectionRequest.findMany({
      where: {
        OR: [
          { status: { in: ["DENIED", "EXPIRED"] } },
          {
            status: "CONSUMED",
            OR: [{ connection: { is: null } }, { connection: { is: { state: "REVOKED" } } }],
          },
        ],
        updatedAt: { lte: new Date(now.getTime() - TERMINAL_RETENTION_MS) },
      },
      orderBy: { updatedAt: "asc" },
      take: 500,
      select: { id: true },
    });
    if (old.length)
      await tx.browserConnectionRequest.deleteMany({
        where: { id: { in: old.map(({ id }) => id) } },
      });
    const buckets = await tx.browserConnectionRateLimitBucket.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: { expiresAt: "asc" },
      take: 1_000,
      select: { key: true },
    });
    if (buckets.length)
      await tx.browserConnectionRateLimitBucket.deleteMany({
        where: { key: { in: buckets.map(({ key }) => key) }, expiresAt: { lte: now } },
      });
  });
}

export async function startBrowserDeviceAuthorization(
  request: Request,
  auditWriter: AuditWriter = prismaAuditWriter,
  options: { entranceConsumed?: boolean } = {},
): Promise<DeviceAuthorizationResponse> {
  if (!options.entranceConsumed) await consumeBrowserEntranceRateLimit(request, "start");
  // Opportunistically reconcile only stale claims; current issuance remains untouched.
  await import("./browser-issuance").then(({ reconcileIncompleteBrowserIssuances }) =>
    reconcileIncompleteBrowserIssuances(),
  );
  const origin = exactRequestOrigin(request);
  const form = await strictForm(request);
  const browserClientId = form.get("client_id")!;
  const resourceIdentifier = form.get("resource")!;
  const resolved = await resolveEnabledBrowserResource({
    browserClientId,
    resourceIdentifier,
    origin,
  });
  if (!resolved)
    throw new WeldallAuthError(
      "invalid_client",
      "browser client, resource, or origin is unavailable",
    );
  const now = new Date();
  await db.$transaction((tx) =>
    consumeRateLimits(
      tx,
      [
        { key: rateKey("start-client", browserClientId), maximum: 200, windowSeconds: 300 },
        {
          key: rateKey("start-resource", resolved.resource.id),
          maximum: 200,
          windowSeconds: 300,
        },
        { key: rateKey("start-origin", origin), maximum: 200, windowSeconds: 300 },
      ],
      now,
    ),
  );
  const proof = request.headers.get("dpop");
  if (!proof) throw new WeldallAuthError("invalid_dpop_proof");
  const dpop = await verifyStrictDpop(proof, {
    method: "POST",
    url: `${WELDALL_ISSUER}/api/auth/oauth2/device_authorization`,
    replay: postgresReplayStore,
  });
  const expiresAt = new Date(now.getTime() + BROWSER_CONNECTION_TTL_SECONDS * 1_000);
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = generateUserCode();
  const identifiers = auditRequestIdentifiers(request);

  await cleanupBrowserConnectionState(now);
  await db.$transaction(async (tx) => {
    await lockBrowserResourceLifecycle(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GLOBAL_QUOTA_LOCK})`;
    const currentResource = await tx.downstreamResource.findUnique({
      where: { id: resolved.resource.id },
      include: { requestPrefixes: { select: { urlPrefix: true } } },
    });
    const currentClient = await tx.oauthClient.findUnique({
      where: { id: resolved.client.id },
    });
    if (
      !currentResource?.enabled ||
      !currentClient ||
      currentClient.disabled ||
      currentClient.referenceId !== currentResource.id ||
      currentClient.clientId !== browserClientId ||
      currentResource.resourceIdentifier !== resourceIdentifier ||
      !browserOriginsForResource(currentResource).includes(origin)
    )
      throw new WeldallAuthError(
        "invalid_client",
        "browser client, resource, or origin is unavailable",
      );
    const [globalActive, resourceActive, originActive, clientActive] = await Promise.all([
      tx.browserConnectionRequest.count({
        where: { status: { in: [...ACTIVE_STATUSES] }, expiresAt: { gt: now } },
      }),
      tx.browserConnectionRequest.count({
        where: {
          resourceId: resolved.resource.id,
          status: { in: [...ACTIVE_STATUSES] },
          expiresAt: { gt: now },
        },
      }),
      tx.browserConnectionRequest.count({
        where: { origin, status: { in: [...ACTIVE_STATUSES] }, expiresAt: { gt: now } },
      }),
      tx.browserConnectionRequest.count({
        where: { browserClientId, status: { in: [...ACTIVE_STATUSES] }, expiresAt: { gt: now } },
      }),
    ]);
    if (
      browserPendingQuotaExceeded({
        global: globalActive,
        resource: resourceActive,
        origin: originActive,
        client: clientActive,
      })
    )
      throw new WeldallAuthError("slow_down", "active connection request quota reached", 429);
    const pending = await tx.browserConnectionRequest.create({
      data: {
        deviceCodeHash: deviceCodeHash(deviceCode),
        userCodeHash: userCodeHash(userCode),
        browserClientId,
        oauthClientId: resolved.client.id,
        resourceId: resolved.resource.id,
        origin,
        dpopJkt: dpop.jkt,
        expiresAt,
        pollIntervalSeconds: BROWSER_CONNECTION_POLL_INTERVAL_SECONDS,
      },
    });
    await auditWriter.write(
      {
        eventType: "browser_connection.requested",
        actorType: "anonymous",
        actorId: browserClientId,
        clientId: browserClientId,
        ...identifiers,
        outcome: "success",
        subjectType: "browser_connection_request",
        subjectId: pending.id,
        metadata: {
          requestId: pending.id,
          browserClientId,
          origin,
          resourceId: resolved.resource.id,
          resourceIdentifier: resolved.resource.resourceIdentifier,
          dpopJkt: dpop.jkt,
          expiresAt: expiresAt.toISOString(),
        },
      },
      tx,
    );
  });
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${WELDALL_ISSUER}/connect`,
    expires_in: BROWSER_CONNECTION_TTL_SECONDS,
    interval: BROWSER_CONNECTION_POLL_INTERVAL_SECONDS,
  };
}

async function consumePendingLimits(
  request: Request,
  userId: string,
  normalizedCode: string,
  operation: "lookup" | "decision",
): Promise<void> {
  const now = new Date();
  await db.$transaction((tx) =>
    consumeRateLimits(
      tx,
      [
        { key: rateKey(`${operation}-account`, userId), maximum: 60, windowSeconds: 300 },
        { key: rateKey(`${operation}-code`, normalizedCode), maximum: 20, windowSeconds: 300 },
      ],
      now,
    ),
  );
}

async function availablePending(
  tx: Prisma.TransactionClient,
  normalizedCode: string,
): Promise<PendingRequest> {
  const pending = await tx.browserConnectionRequest.findUnique({
    where: { userCodeHash: userCodeHash(normalizedCode) },
    include: { resource: true, oauthClient: true, approvedByUser: true },
  });
  const now = new Date();
  if (
    pending &&
    pending.expiresAt <= now &&
    ["PENDING", "APPROVED", "ISSUING"].includes(pending.status)
  )
    await tx.browserConnectionRequest.updateMany({
      where: { id: pending.id, status: { in: [...ACTIVE_STATUSES] } },
      data: { status: "EXPIRED" },
    });
  if (!pending || pending.status !== "PENDING" || pending.expiresAt <= now)
    throw new WeldallAuthError("invalid_grant", "connection code is unavailable");
  if (
    pending.oauthClient.disabled ||
    !pending.resource.enabled ||
    pending.browserClientId !== browserClientIdForResourceKey(pending.resource.key) ||
    !browserOriginsForResource({
      ...pending.resource,
      requestPrefixes: await tx.resourceRequestPrefix.findMany({
        where: { resourceId: pending.resourceId },
        select: { urlPrefix: true },
      }),
    }).includes(pending.origin)
  )
    throw new WeldallAuthError("invalid_grant", "connection code is unavailable");
  return pending;
}

function pendingContext(
  pending: PendingRequest,
  user: { id: string; email: string },
  userCode: string,
): PendingBrowserContext {
  return {
    requestId: pending.id,
    userCode,
    origin: pending.origin,
    resource: {
      id: pending.resource.id,
      key: pending.resource.key,
      name: pending.resource.name,
      identifier: pending.resource.resourceIdentifier,
    },
    browserClientId: pending.browserClientId,
    expiresAt: pending.expiresAt.toISOString(),
    account: user,
  };
}

export async function lookupPendingBrowserConnection(
  request: Request,
  user: { id: string; email: string },
  normalizedCode: string,
): Promise<PendingBrowserContext> {
  await consumePendingLimits(request, user.id, normalizedCode, "lookup");
  if (!(await hasLoginScopeForUserId(user.id)))
    throw new WeldallAuthError("insufficient_scope", "weldall:login is required", 403, [
      "weldall:login",
    ]);
  return db.$transaction(async (tx) => {
    await lockBrowserResourceLifecycle(tx);
    return pendingContext(await availablePending(tx, normalizedCode), user, normalizedCode);
  });
}

export async function decidePendingBrowserConnection(
  request: Request,
  user: { id: string; email: string },
  normalizedCode: string,
  approve: boolean,
  auditWriter: AuditWriter = prismaAuditWriter,
): Promise<{ approved: boolean; context: PendingBrowserContext }> {
  await consumePendingLimits(request, user.id, normalizedCode, "decision");
  if (!(await hasLoginScopeForUserId(user.id)))
    throw new WeldallAuthError("insufficient_scope", "weldall:login is required", 403, [
      "weldall:login",
    ]);
  const identifiers = auditRequestIdentifiers(request);
  const context = await db.$transaction(async (tx) => {
    await lockBrowserResourceLifecycle(tx);
    const pending = await availablePending(tx, normalizedCode);
    const now = new Date();
    const changed = await tx.browserConnectionRequest.updateMany({
      where: { id: pending.id, status: "PENDING", expiresAt: { gt: now } },
      data: approve
        ? {
            status: "APPROVED",
            approvedAt: now,
            approvedByUserId: user.id,
            decidedByUserId: user.id,
          }
        : { status: "DENIED", deniedAt: now, decidedByUserId: user.id },
    });
    if (changed.count !== 1)
      throw new WeldallAuthError("invalid_grant", "connection code is unavailable");
    await auditWriter.write(
      {
        eventType: approve ? "browser_connection.approved" : "browser_connection.denied",
        actorType: "user",
        actorId: user.id,
        actorEmail: user.email,
        clientId: "weldall-cli",
        ...identifiers,
        outcome: approve ? "success" : "denied",
        ...(approve ? {} : { reasonCode: "invalid_grant" as const }),
        subjectType: "browser_connection_request",
        subjectId: pending.id,
        metadata: {
          requestId: pending.id,
          browserClientId: pending.browserClientId,
          origin: pending.origin,
          resourceId: pending.resourceId,
          resourceIdentifier: pending.resource.resourceIdentifier,
          dpopJkt: pending.dpopJkt,
          expiresAt: pending.expiresAt.toISOString(),
          cliSourceClient: "weldall-cli",
          approvedVia: "cli-code",
        },
      },
      tx,
    );
    return pendingContext(pending, user, normalizedCode);
  });
  return { approved: approve, context };
}

type PollBrowserConnectionDependencies = {
  /** Narrow service seam used by deterministic policy/lifecycle race tests. */
  loginPolicy?: (userId: string) => Promise<boolean>;
};

async function revokeAmbiguousConsumedIssuance(
  tx: Prisma.TransactionClient,
  pending: PendingRequest,
  now: Date,
): Promise<void> {
  const attempt = await tx.browserConnectionIssuanceAttempt.findUnique({
    where: { requestId: pending.id },
    include: { connection: true },
  });
  const connection = attempt?.connection;
  if (
    !attempt ||
    attempt.status !== "COMMITTED" ||
    !connection ||
    pending.connectionId !== connection.id ||
    connection.refreshFamilyId !== attempt.refreshFamilyId
  )
    return;

  await Promise.all([
    tx.oauthRefreshToken.updateMany({
      where: { referenceId: connection.providerReferenceId, revoked: null },
      data: { revoked: now },
    }),
    tx.oauthAccessToken.updateMany({
      where: { referenceId: connection.providerReferenceId, revoked: null },
      data: { revoked: now },
    }),
    tx.oAuthDeviceRefreshBinding.updateMany({
      where: { familyId: connection.refreshFamilyId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
  const revokedConnection = await tx.browserConnection.updateMany({
    where: { id: connection.id, state: "ACTIVE" },
    data: {
      state: "REVOKED",
      revokedAt: now,
      revokedBy: "issuance-reconciler",
      revocationReason: "response_delivery_ambiguous",
    },
  });
  await tx.browserConnectionIssuanceAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "FAILED",
      failedAt: now,
      failureCode: "reconciled:response_delivery_ambiguous",
    },
  });

  await prismaAuditWriter.write(
    {
      eventType: "browser_connection.failed",
      actorType: "machine",
      actorId: "issuance-reconciler",
      clientId: pending.browserClientId,
      requestId: pending.id,
      outcome: "failed",
      reasonCode: "internal_error",
      subjectType: "browser_connection_request",
      subjectId: pending.id,
      metadata: {
        stage: "issuance",
        requestId: pending.id,
        connectionId: connection.id,
        browserClientId: pending.browserClientId,
        origin: pending.origin,
        resourceIdentifier: pending.resource.resourceIdentifier,
        dpopJkt: pending.dpopJkt,
      },
    },
    tx,
  );
  if (revokedConnection.count > 0)
    await prismaAuditWriter.write(
      {
        eventType: "browser_connection.revoked",
        actorType: "machine",
        actorId: "issuance-reconciler",
        clientId: connection.browserClientId,
        requestId: pending.id,
        outcome: "success",
        subjectType: "browser_connection",
        subjectId: connection.id,
        metadata: {
          connectionId: connection.id,
          browserClientId: connection.browserClientId,
          origin: connection.origin,
          resourceId: connection.resourceId,
          resourceIdentifier: connection.resourceIdentifier,
          dpopJkt: connection.dpopJkt,
          approvedVia: connection.approvedVia,
          revocationReason: "response_delivery_ambiguous",
        },
      },
      tx,
    );
}

export async function pollBrowserConnectionRequest(
  input: {
    request: Request;
    deviceCode: string;
    browserClientId: string;
    now?: Date;
  },
  dependencies: PollBrowserConnectionDependencies = {},
): Promise<PendingRequest> {
  await consumeBrowserEntranceRateLimit(input.request, "poll");
  const origin = exactRequestOrigin(input.request);
  const proof = input.request.headers.get("dpop");
  if (!proof) throw new WeldallAuthError("invalid_dpop_proof");
  const dpop = await verifyStrictDpop(proof, {
    method: "POST",
    url: WELDALL_TOKEN_ENDPOINT,
    replay: postgresReplayStore,
  });
  const now = input.now ?? new Date();
  const outcome = await db.$transaction(async (tx) => {
    await lockBrowserResourceLifecycle(tx);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BrowserConnectionRequest"
      WHERE "deviceCodeHash" = ${deviceCodeHash(input.deviceCode)}
      FOR UPDATE
    `;
    if (!locked[0]) throw new WeldallAuthError("invalid_grant");
    const pending = await tx.browserConnectionRequest.findUniqueOrThrow({
      where: { id: locked[0].id },
      include: { resource: true, oauthClient: true, approvedByUser: true },
    });
    const prefixes = await tx.resourceRequestPrefix.findMany({
      where: { resourceId: pending.resourceId },
      select: { urlPrefix: true },
    });
    const bindingValid =
      pending.browserClientId === input.browserClientId &&
      pending.origin === origin &&
      pending.dpopJkt === dpop.jkt &&
      pending.resource.enabled &&
      !pending.oauthClient.disabled &&
      pending.oauthClient.referenceId === pending.resourceId &&
      browserOriginsForResource({ ...pending.resource, requestPrefixes: prefixes }).includes(
        origin,
      );
    if (!bindingValid) throw new WeldallAuthError("invalid_grant");
    await consumeRateLimits(
      tx,
      [
        {
          key: rateKey("poll-client", pending.browserClientId),
          maximum: 5_000,
          windowSeconds: 300,
        },
        {
          key: rateKey("poll-resource", pending.resourceId),
          maximum: 5_000,
          windowSeconds: 300,
        },
        { key: rateKey("poll-origin", pending.origin), maximum: 5_000, windowSeconds: 300 },
        {
          key: rateKey("poll-account", pending.approvedByUserId ?? `unapproved:${pending.id}`),
          maximum: 1_000,
          windowSeconds: 300,
        },
        { key: rateKey("poll-request", pending.id), maximum: 120, windowSeconds: 300 },
      ],
      now,
    );
    if (pending.status === "CONSUMED") {
      // A valid same-secret/same-JKT retry is the only signal available after a
      // process dies between durable commit and response delivery. Revoke the
      // now-ambiguous family before returning the enumeration-resistant error,
      // even when the original five-minute polling window has elapsed.
      await revokeAmbiguousConsumedIssuance(tx, pending, now);
      return { error: "invalid_grant" as const };
    }
    if (pending.expiresAt <= now) {
      await tx.browserConnectionIssuanceAttempt.updateMany({
        where: {
          requestId: pending.id,
          status: { in: ["CLAIMED", "PROVIDER_ISSUED", "BINDING_CREATED"] },
        },
        data: { status: "FAILED", failureCode: "expired", failedAt: now },
      });
      await tx.browserConnectionRequest.updateMany({
        where: { id: pending.id, status: { in: [...ACTIVE_STATUSES] } },
        data: { status: "EXPIRED" },
      });
      return { error: "expired_token" as const };
    }
    if (pending.status === "DENIED") return { error: "access_denied" as const };
    if (pending.status === "EXPIRED") return { error: "expired_token" as const };
    if (pending.status === "ISSUING") return { error: "invalid_grant" as const };
    if (pending.lastPolledAt) {
      const earliest = pending.lastPolledAt.getTime() + pending.pollIntervalSeconds * 1_000;
      if (now.getTime() < earliest) {
        await tx.browserConnectionRequest.update({
          where: { id: pending.id },
          data: {
            attempts: { increment: 1 },
            lastPolledAt: now,
            pollIntervalSeconds: Math.min(300, pending.pollIntervalSeconds + 5),
          },
        });
        return { error: "slow_down" as const };
      }
    }
    if (pending.status === "PENDING") {
      await tx.browserConnectionRequest.update({
        where: { id: pending.id },
        data: { attempts: { increment: 1 }, lastPolledAt: now },
      });
      return { error: "authorization_pending" as const };
    }
    const attempt = await tx.browserConnectionIssuanceAttempt.create({
      data: { requestId: pending.id, refreshFamilyId: randomUUID() },
    });
    const claimed = await tx.browserConnectionRequest.update({
      where: { id: pending.id },
      data: {
        status: "ISSUING",
        issuanceClaimedAt: now,
        attempts: { increment: 1 },
        lastPolledAt: now,
      },
      include: { resource: true, oauthClient: true, approvedByUser: true },
    });
    return { pending: claimed, attemptId: attempt.id, refreshFamilyId: attempt.refreshFamilyId };
  });
  if ("pending" in outcome && outcome.pending) {
    const claimed = outcome.pending;
    let loginAllowed = false;
    try {
      loginAllowed = Boolean(
        claimed.approvedByUserId &&
        (await (dependencies.loginPolicy ?? hasLoginScopeForUserId)(claimed.approvedByUserId)),
      );
    } catch {
      loginAllowed = false;
    }
    if (!loginAllowed) {
      await db.$transaction(async (tx) => {
        await lockBrowserResourceLifecycle(tx);
        const failedAt = new Date();
        await tx.browserConnectionIssuanceAttempt.updateMany({
          where: { requestId: claimed.id, status: "CLAIMED" },
          data: { status: "FAILED", failureCode: "login_access_removed", failedAt },
        });
        await tx.browserConnectionRequest.updateMany({
          where: { id: claimed.id, status: "ISSUING" },
          data: { status: "DENIED", deniedAt: failedAt },
        });
      });
      throw new WeldallAuthError("invalid_grant", "login access is no longer available");
    }

    // Login/group-provider resolution is intentionally outside the database
    // transaction. Reacquire both lifecycle and row locks and prove that no
    // resource/origin/client mutation cancelled or changed this exact claim.
    return db.$transaction(async (tx) => {
      await lockBrowserResourceLifecycle(tx);
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BrowserConnectionRequest"
        WHERE "id" = ${claimed.id}
        FOR UPDATE
      `;
      if (!locked[0]) throw new WeldallAuthError("invalid_grant");
      const [current, attempt, prefixes] = await Promise.all([
        tx.browserConnectionRequest.findUnique({
          where: { id: claimed.id },
          include: { resource: true, oauthClient: true, approvedByUser: true },
        }),
        tx.browserConnectionIssuanceAttempt.findUnique({ where: { requestId: claimed.id } }),
        tx.resourceRequestPrefix.findMany({
          where: { resourceId: claimed.resourceId },
          select: { urlPrefix: true },
        }),
      ]);
      const currentOriginAllowed = Boolean(
        current &&
        browserOriginsForResource({ ...current.resource, requestPrefixes: prefixes }).includes(
          origin,
        ),
      );
      if (
        !current ||
        current.status !== "ISSUING" ||
        current.expiresAt <= new Date() ||
        current.issuanceClaimedAt?.getTime() !== claimed.issuanceClaimedAt?.getTime() ||
        current.approvedByUserId !== claimed.approvedByUserId ||
        current.browserClientId !== input.browserClientId ||
        current.origin !== origin ||
        current.dpopJkt !== dpop.jkt ||
        !current.resource.enabled ||
        current.oauthClient.disabled ||
        current.oauthClient.referenceId !== current.resourceId ||
        !currentOriginAllowed ||
        !attempt ||
        attempt.id !== outcome.attemptId ||
        attempt.refreshFamilyId !== outcome.refreshFamilyId ||
        attempt.status !== "CLAIMED"
      )
        throw new WeldallAuthError("invalid_grant", "connection claim is no longer available");
      return current;
    });
  }
  const messages: Record<typeof outcome.error, string> = {
    access_denied: "connection denied",
    authorization_pending: "approval is pending",
    expired_token: "device code expired",
    invalid_grant: "invalid grant",
    slow_down: "polling too quickly",
  };
  throw new WeldallAuthError(outcome.error, messages[outcome.error]);
}
