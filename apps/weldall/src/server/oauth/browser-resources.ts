import { Prisma, db } from "@weldall/db";
import { prismaAuditWriter } from "../audit/service";

export const BROWSER_CLIENT_PREFIX = "weldall-browser:";
const BROWSER_RESOURCE_LIFECYCLE_LOCK = 1_462_763_316;
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const BROWSER_INFRASTRUCTURE_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "weldall:scopes",
] as const;

export type BrowserResourceShape = {
  id: string;
  key: string;
  name: string;
  resourceIdentifier: string;
  authorizationServer: string;
  enabled: boolean;
  requestPrefixes: readonly { urlPrefix: string }[];
};

export async function lockBrowserResourceLifecycle(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BROWSER_RESOURCE_LIFECYCLE_LOCK})`;
}

export function browserClientIdForResourceKey(resourceKey: string): string {
  return `${BROWSER_CLIENT_PREFIX}${resourceKey}`;
}

/** Exact SPA origins derived only from authoritative resource URL fields. */
export function browserOriginsForResource(resource: BrowserResourceShape): string[] {
  return [
    ...new Set([
      new URL(resource.authorizationServer).origin,
      ...resource.requestPrefixes.map(({ urlPrefix }) => new URL(urlPrefix).origin),
    ]),
  ].sort();
}

function clientMetadata(resource: BrowserResourceShape): Prisma.InputJsonObject {
  return {
    weldallBrowser: {
      schemaVersion: 1,
      resourceId: resource.id,
      resourceKey: resource.key,
      resourceIdentifier: resource.resourceIdentifier,
      allowedOrigins: browserOriginsForResource(resource),
    },
  };
}

/** Provision or repair the stable public browser client for a resource. */
export async function reconcileResourceBrowserClient(
  tx: Prisma.TransactionClient,
  resource: BrowserResourceShape,
): Promise<void> {
  const clientId = browserClientIdForResourceKey(resource.key);
  const origins = browserOriginsForResource(resource);
  const primaryOrigin = origins[0]!;
  const existing = await tx.oauthClient.findUnique({ where: { clientId } });
  if (existing && (existing.id !== clientId || existing.referenceId !== resource.id)) {
    throw new Error(`Browser client ${clientId} is already bound to another resource`);
  }
  await tx.oauthClient.upsert({
    where: { clientId },
    create: {
      id: clientId,
      clientId,
      disabled: !resource.enabled,
      skipConsent: true,
      enableEndSession: false,
      scopes: [...BROWSER_INFRASTRUCTURE_SCOPES],
      name: `${resource.name} browser`,
      uri: primaryOrigin,
      redirectUris: [],
      postLogoutRedirectUris: [],
      tokenEndpointAuthMethod: "none",
      grantTypes: [DEVICE_GRANT_TYPE, "refresh_token", TOKEN_EXCHANGE_GRANT_TYPE],
      responseTypes: [],
      public: true,
      type: "web",
      requirePKCE: false,
      dpopBoundAccessTokens: true,
      referenceId: resource.id,
      metadata: clientMetadata(resource),
    },
    update: {
      clientSecret: null,
      disabled: !resource.enabled,
      skipConsent: true,
      enableEndSession: false,
      scopes: [...BROWSER_INFRASTRUCTURE_SCOPES],
      userId: null,
      name: `${resource.name} browser`,
      uri: primaryOrigin,
      redirectUris: [],
      postLogoutRedirectUris: [],
      tokenEndpointAuthMethod: "none",
      jwks: null,
      jwksUri: null,
      grantTypes: [DEVICE_GRANT_TYPE, "refresh_token", TOKEN_EXCHANGE_GRANT_TYPE],
      responseTypes: [],
      public: true,
      type: "web",
      requirePKCE: false,
      dpopBoundAccessTokens: true,
      referenceId: resource.id,
      metadata: clientMetadata(resource),
    },
  });
}

export async function revokeResourceBrowserState(
  tx: Prisma.TransactionClient,
  resource: Pick<BrowserResourceShape, "id" | "key">,
  input: {
    removedOrigins?: readonly string[];
    actorId: string;
    actorType?: "user" | "machine";
    actorEmail?: string | null;
    requestId: string;
    correlationId?: string;
    reason: string;
  },
): Promise<void> {
  const now = new Date();
  const connectionWhere: Prisma.BrowserConnectionWhereInput = {
    state: "ACTIVE",
    OR: [{ resourceId: resource.id }, { resourceKey: resource.key }],
    ...(input.removedOrigins?.length ? { origin: { in: [...input.removedOrigins] } } : {}),
  };
  const connections = await tx.browserConnection.findMany({
    where: connectionWhere,
    select: {
      id: true,
      refreshFamilyId: true,
      browserClientId: true,
      origin: true,
      resourceId: true,
      resourceIdentifier: true,
      dpopJkt: true,
      approvedVia: true,
      providerReferenceId: true,
    },
  });
  if (connections.length) {
    await tx.browserConnection.updateMany({
      where: { id: { in: connections.map(({ id }) => id) }, state: "ACTIVE" },
      data: {
        state: "REVOKED",
        revokedAt: now,
        revokedBy: input.actorId,
        revocationReason: input.reason,
      },
    });
    await tx.oAuthDeviceRefreshBinding.updateMany({
      where: {
        revokedAt: null,
        OR: [
          { browserConnectionId: { in: connections.map(({ id }) => id) } },
          { familyId: { in: connections.map(({ refreshFamilyId }) => refreshFamilyId) } },
        ],
      },
      data: { revokedAt: now },
    });
    const providerReferences = connections.map(({ providerReferenceId }) => providerReferenceId);
    if (providerReferences.length) {
      await tx.oauthRefreshToken.updateMany({
        where: { referenceId: { in: providerReferences }, revoked: null },
        data: { revoked: now },
      });
      await tx.oauthAccessToken.updateMany({
        where: { referenceId: { in: providerReferences }, revoked: null },
        data: { revoked: now },
      });
    }
    for (const connection of connections)
      await prismaAuditWriter.write(
        {
          eventType: "browser_connection.revoked",
          actorType: input.actorType ?? "machine",
          actorId: input.actorId,
          ...(input.actorEmail ? { actorEmail: input.actorEmail } : {}),
          requestId: input.requestId,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
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
            revocationReason: input.reason,
          },
        },
        tx,
      );
  }
  const requestWhere: Prisma.BrowserConnectionRequestWhereInput = {
    resourceId: resource.id,
    status: { in: ["PENDING", "APPROVED", "ISSUING"] },
    ...(input.removedOrigins?.length ? { origin: { in: [...input.removedOrigins] } } : {}),
  };
  const requests = await tx.browserConnectionRequest.findMany({
    where: requestWhere,
    select: {
      id: true,
      status: true,
      browserClientId: true,
      origin: true,
      dpopJkt: true,
      resource: { select: { resourceIdentifier: true } },
      issuanceAttempt: {
        select: {
          providerAccessTokenHash: true,
          providerRefreshTokenHash: true,
          refreshFamilyId: true,
          connectionId: true,
        },
      },
    },
  });
  const requestIds = requests.map(({ id }) => id);
  if (requestIds.length) {
    await tx.oauthRefreshToken.updateMany({
      where: { referenceId: { in: requestIds }, revoked: null },
      data: { revoked: now },
    });
    await tx.oauthAccessToken.updateMany({
      where: { referenceId: { in: requestIds }, revoked: null },
      data: { revoked: now },
    });
  }
  const attempts = requests.flatMap(({ issuanceAttempt }) =>
    issuanceAttempt ? [issuanceAttempt] : [],
  );
  const accessHashes = attempts.flatMap(({ providerAccessTokenHash }) =>
    providerAccessTokenHash ? [providerAccessTokenHash] : [],
  );
  const refreshHashes = attempts.flatMap(({ providerRefreshTokenHash }) =>
    providerRefreshTokenHash ? [providerRefreshTokenHash] : [],
  );
  const attemptFamilies = attempts.flatMap(({ refreshFamilyId }) =>
    refreshFamilyId ? [refreshFamilyId] : [],
  );
  if (accessHashes.length)
    await tx.oauthAccessToken.updateMany({
      where: { token: { in: accessHashes }, revoked: null },
      data: { revoked: now },
    });
  if (refreshHashes.length)
    await tx.oauthRefreshToken.updateMany({
      where: { token: { in: refreshHashes }, revoked: null },
      data: { revoked: now },
    });
  if (attemptFamilies.length)
    await tx.oAuthDeviceRefreshBinding.updateMany({
      where: { familyId: { in: attemptFamilies }, revokedAt: null },
      data: { revokedAt: now },
    });
  if (requests.length) {
    await tx.browserConnectionIssuanceAttempt.updateMany({
      where: {
        requestId: { in: requests.map(({ id }) => id) },
        status: { in: ["CLAIMED", "PROVIDER_ISSUED", "BINDING_CREATED"] },
      },
      data: { status: "FAILED", failureCode: input.reason, failedAt: now },
    });
    await tx.browserConnectionRequest.updateMany({
      where: {
        id: { in: requests.map(({ id }) => id) },
        status: { in: ["PENDING", "APPROVED", "ISSUING"] },
      },
      data: { status: "DENIED", deniedAt: now },
    });
    for (const request of requests.filter(({ status }) => status === "ISSUING"))
      await prismaAuditWriter.write(
        {
          eventType: "browser_connection.failed",
          actorType: input.actorType ?? "machine",
          actorId: input.actorId,
          ...(input.actorEmail ? { actorEmail: input.actorEmail } : {}),
          requestId: input.requestId,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          outcome: "failed",
          reasonCode:
            input.reason === "origin_removed"
              ? "origin_not_allowed"
              : input.reason === "resource_disabled"
                ? "resource_disabled"
                : "invalid_resource",
          subjectType: "browser_connection_request",
          subjectId: request.id,
          metadata: {
            stage: "issuance",
            requestId: request.id,
            connectionId: request.issuanceAttempt?.connectionId ?? null,
            browserClientId: request.browserClientId,
            origin: request.origin,
            resourceIdentifier: request.resource.resourceIdentifier,
            dpopJkt: request.dpopJkt,
          },
        },
        tx,
      );
  }
}

export async function removeResourceBrowserClient(
  tx: Prisma.TransactionClient,
  resource: Pick<BrowserResourceShape, "id" | "key">,
): Promise<void> {
  const clientId = browserClientIdForResourceKey(resource.key);
  await tx.oauthClient.deleteMany({ where: { clientId, referenceId: resource.id } });
}

export async function resolveEnabledBrowserResource(input: {
  browserClientId: string;
  resourceIdentifier: string;
  origin: string;
}) {
  const resource = await db.downstreamResource.findUnique({
    where: { resourceIdentifier: input.resourceIdentifier },
    include: { requestPrefixes: { select: { urlPrefix: true } } },
  });
  if (
    !resource?.enabled ||
    input.browserClientId !== browserClientIdForResourceKey(resource.key) ||
    !browserOriginsForResource(resource).includes(input.origin)
  ) {
    return null;
  }
  const client = await db.oauthClient.findUnique({ where: { clientId: input.browserClientId } });
  if (
    !client ||
    client.disabled ||
    client.referenceId !== resource.id ||
    client.tokenEndpointAuthMethod !== "none" ||
    client.dpopBoundAccessTokens !== true ||
    !client.grantTypes.includes(DEVICE_GRANT_TYPE)
  ) {
    return null;
  }
  return { resource, client, origins: browserOriginsForResource(resource) };
}

export async function isCurrentEnabledBrowserOrigin(origin: string): Promise<boolean> {
  const resources = await db.downstreamResource.findMany({
    where: { enabled: true },
    include: { requestPrefixes: { select: { urlPrefix: true } } },
  });
  return resources.some((resource) => browserOriginsForResource(resource).includes(origin));
}
