import { db, Prisma } from "@weldall/db";
import { safeEqual, verifyEs256, verifyStrictDpop, WeldallAuthError } from "@weldall/sdk";
import { hasLoginScopeForUserId } from "../auth/login-policy";
import { auditRequestIdentifiers, prismaAuditWriter } from "../audit/service";
import { getWeldallSigningKey } from "./jwt";
import { browserOriginsForResource, lockBrowserResourceLifecycle } from "./browser-resources";
import { revokeBrowserConnectionFamily } from "./browser-issuance";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "./constants";
import { postgresReplayStore } from "./replay";

export type BrowserConnectionDto = {
  id: string;
  state: "active" | "revoked";
  origin: string;
  resource: string;
  resourceKey: string;
  subject: string;
  browserClientId: string;
  approvedVia: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  account: { id: string; email: string; name: string } | null;
};

function exactOrigin(request: Request): string {
  const raw = request.headers.get("origin");
  if (!raw || raw === "null")
    throw new WeldallAuthError("browser_origin_invalid", "Origin is invalid", 403);
  try {
    const url = new URL(raw);
    if (url.origin !== raw || url.protocol !== "https:") throw new Error("origin");
    return url.origin;
  } catch {
    throw new WeldallAuthError("browser_origin_invalid", "Origin is invalid", 403);
  }
}

const connectionInclude = {
  resource: { include: { requestPrefixes: { select: { urlPrefix: true } } } },
  oauthClient: true,
  userReference: { select: { id: true, email: true, name: true } },
} as const;

type LoadedConnection = Prisma.BrowserConnectionGetPayload<{ include: typeof connectionInclude }>;

export async function authenticateBrowserConnectionRequest(
  request: Request,
  expectedUrl: string,
  options: { allowRevoked?: boolean } = {},
): Promise<LoadedConnection> {
  const authorization = request.headers.get("authorization");
  const proof = request.headers.get("dpop");
  if (!authorization?.startsWith("DPoP ") || authorization.includes(",") || !proof)
    throw new WeldallAuthError("invalid_token", "DPoP authorization required", 401);
  const token = authorization.slice(5);
  const key = await getWeldallSigningKey();
  const payload = await verifyEs256(token, {
    issuer: WELDALL_ISSUER,
    audience: WELDALL_RESOURCE,
    kid: key.kid,
    publicJwk: key.publicJwk,
    typ: "at+jwt",
    errorCode: "invalid_token",
    errorStatus: 401,
  });
  const connectionId = payload.weldall_connection_id;
  const clientId = payload.client_id;
  const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt;
  if (
    typeof payload.sub !== "string" ||
    typeof connectionId !== "string" ||
    typeof clientId !== "string" ||
    (payload.azp !== undefined && payload.azp !== clientId) ||
    !clientId.startsWith("weldall-browser:") ||
    typeof jkt !== "string"
  )
    throw new WeldallAuthError("invalid_token", "browser connection token required", 401);
  await verifyStrictDpop(proof, {
    method: request.method,
    url: expectedUrl,
    replay: postgresReplayStore,
    accessToken: token,
    expectedJkt: jkt,
  });
  const origin = exactOrigin(request);
  const connection = await db.browserConnection.findUnique({
    where: { id: connectionId },
    include: connectionInclude,
  });
  if (
    !connection ||
    connection.userId !== payload.sub ||
    connection.browserClientId !== clientId ||
    !safeEqual(connection.dpopJkt, jkt) ||
    connection.origin !== origin ||
    payload.weldall_connection_origin !== connection.origin ||
    payload.weldall_connection_resource !== connection.resourceIdentifier
  )
    throw new WeldallAuthError("browser_connection_invalid", "browser connection is invalid", 401);
  if (connection.state !== "ACTIVE") {
    if (options.allowRevoked) return connection;
    throw new WeldallAuthError("browser_connection_revoked", "browser connection is revoked", 401);
  }
  if (
    !connection.resource ||
    !connection.resource.enabled ||
    !connection.oauthClient ||
    connection.oauthClient.disabled ||
    connection.oauthClient.clientId !== connection.browserClientId ||
    connection.oauthClient.referenceId !== connection.resource.id ||
    connection.resourceIdentifier !== connection.resource.resourceIdentifier ||
    !browserOriginsForResource(connection.resource).includes(origin)
  )
    throw new WeldallAuthError(
      "browser_connection_origin_changed",
      "browser origin or resource changed",
      403,
    );
  if (!(await hasLoginScopeForUserId(connection.userId)))
    throw new WeldallAuthError("invalid_grant", "login access is no longer available", 403);
  return connection;
}

function serializeConnection(connection: LoadedConnection): BrowserConnectionDto {
  return {
    id: connection.id,
    state: connection.state === "ACTIVE" ? "active" : "revoked",
    origin: connection.origin,
    resource: connection.resourceIdentifier,
    resourceKey: connection.resourceKey,
    subject: connection.userId,
    browserClientId: connection.browserClientId,
    approvedVia: connection.approvedVia,
    createdAt: connection.createdAt.toISOString(),
    lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
    revokedAt: connection.revokedAt?.toISOString() ?? null,
    account: connection.userReference
      ? {
          id: connection.userReference.id,
          email: connection.userReference.email,
          name: connection.userReference.name,
        }
      : null,
  };
}

export async function currentBrowserConnectionStatus(request: Request, expectedUrl: string) {
  return serializeConnection(await authenticateBrowserConnectionRequest(request, expectedUrl));
}

export async function revokeCurrentBrowserConnection(request: Request, expectedUrl: string) {
  const connection = await authenticateBrowserConnectionRequest(request, expectedUrl, {
    allowRevoked: true,
  });
  if (connection.state === "REVOKED") return { revoked: true, connectionId: connection.id };
  const identifiers = auditRequestIdentifiers(request);
  await db.$transaction(async (tx) => {
    await lockBrowserResourceLifecycle(tx);
    const changed = await revokeBrowserConnectionFamily(tx, connection.id, {
      actorId: connection.userId,
      reason: "browser_disconnect",
    });
    if (changed)
      await prismaAuditWriter.write(
        {
          eventType: "browser_connection.revoked",
          actorType: "user",
          actorId: connection.userId,
          clientId: connection.browserClientId,
          ...identifiers,
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
            revocationReason: "browser_disconnect",
          },
        },
        tx,
      );
  });
  return { revoked: true, connectionId: connection.id };
}

export async function listBrowserConnections(input: {
  userId?: string | undefined;
  resourceId?: string | undefined;
  origin?: string | undefined;
  includeRevoked?: boolean | undefined;
}): Promise<BrowserConnectionDto[]> {
  const rows = await db.browserConnection.findMany({
    where: {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.includeRevoked ? {} : { state: "ACTIVE" }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: connectionInclude,
  });
  return rows.map(serializeConnection);
}

export async function revokeBrowserConnections(
  input: {
    connectionId?: string | undefined;
    userId?: string | undefined;
    resourceId?: string | undefined;
    origin?: string | undefined;
  },
  actor: { id: string; email?: string | null; requestId: string; correlationId?: string },
): Promise<{ revoked: number }> {
  if (!input.connectionId && !input.userId && !input.resourceId && !input.origin)
    throw new TypeError("A browser connection revocation selector is required");
  return db.$transaction(async (tx) => {
    await lockBrowserResourceLifecycle(tx);
    const connections = await tx.browserConnection.findMany({
      where: {
        state: "ACTIVE",
        ...(input.connectionId ? { id: input.connectionId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
      },
      include: connectionInclude,
    });
    let revoked = 0;
    for (const connection of connections) {
      if (
        await revokeBrowserConnectionFamily(tx, connection.id, {
          actorId: actor.id,
          reason: "administrative_revocation",
        })
      ) {
        revoked += 1;
        await prismaAuditWriter.write(
          {
            eventType: "browser_connection.revoked",
            actorType: "user",
            actorId: actor.id,
            ...(actor.email ? { actorEmail: actor.email } : {}),
            requestId: actor.requestId,
            ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
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
              revocationReason: "administrative_revocation",
            },
          },
          tx,
        );
      }
    }
    return { revoked };
  });
}
