import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import {
  extendOAuthProvider,
  type OAuthProviderApi,
  type OAuthProviderExtension,
  type OAuthTokenResponse,
} from "@better-auth/oauth-provider";
import { db, Prisma } from "@weldall/db";
import { WeldallAuthError } from "@weldall/sdk";
import { hasLoginScopeForUserId } from "../auth/login-policy";
import { auditRequestIdentifiers, prismaAuditWriter } from "../audit/service";
import { auditBrowserConnectionFailure, pollBrowserConnectionRequest } from "./browser-connections";
import {
  BROWSER_INFRASTRUCTURE_SCOPES,
  BROWSER_LIFECYCLE_TRANSACTION_OPTIONS,
  DEVICE_GRANT_TYPE,
  browserOriginsForResource,
  lockBrowserResourceLifecycle,
} from "./browser-resources";
import { WELDALL_RESOURCE } from "./constants";

const hash = (value: string) => createHash("sha256").update(value, "ascii").digest("base64url");
const BROWSER_REFRESH_LIFETIME_MS = 30 * 86_400_000;

export type BrowserIssuanceKillPoint =
  | "after-claim"
  | "after-provider-return"
  | "after-provider-issuance"
  | "after-binding"
  | "after-commit"
  | "response-loss";

export type BrowserIssuanceDependencies = {
  killPoint?: (point: BrowserIssuanceKillPoint) => Promise<void> | void;
};

function confirmationJkt(value: unknown): string | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const jkt = (parsed as Record<string, unknown>).jkt;
  return typeof jkt === "string" ? jkt : undefined;
}

function requiredBodyString(body: unknown, name: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new WeldallAuthError("invalid_request");
  const value = (body as Record<string, unknown>)[name];
  if (typeof value !== "string" || !value) throw new WeldallAuthError("invalid_request");
  return value;
}

async function linkedConnectionClaims(referenceId: string | undefined, clientId: string) {
  if (!clientId.startsWith("weldall-browser:") || !referenceId) return {};
  const connection = await db.browserConnection.findUnique({
    where: { providerReferenceId: referenceId },
  });
  if (!connection || connection.browserClientId !== clientId) return {};
  return {
    weldall_connection_id: connection.id,
    weldall_connection_origin: connection.origin,
    weldall_connection_resource: connection.resourceIdentifier,
  };
}

export const browserConnectionOAuthExtension: OAuthProviderExtension = {
  grants: {
    [DEVICE_GRANT_TYPE]: async ({ ctx, provider }) => {
      if (!ctx.request) throw new APIError("BAD_REQUEST", { error: "invalid_request" });
      try {
        return await issueBrowserDeviceTokens(
          {
            request: ctx.request,
            body: ctx.body,
            provider,
          },
          {},
        );
      } catch (error) {
        await auditBrowserConnectionFailure(ctx.request, "issuance", error);
        if (error instanceof APIError) throw error;
        if (error instanceof WeldallAuthError) {
          throw new APIError(error.status >= 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST", {
            error: error.code,
            error_description: error.message,
          });
        }
        throw new APIError("INTERNAL_SERVER_ERROR", {
          error: "server_error",
          error_description: "browser credential issuance failed",
        });
      }
    },
  },
  claims: {
    accessToken: ({ referenceId, client }) => linkedConnectionClaims(referenceId, client.clientId),
    idToken: ({ referenceId, client }) => linkedConnectionClaims(referenceId, client.clientId),
  },
};

/** Better Auth companion plugin; all token issuance stays on the exported provider capability. */
export function browserConnectionOAuthPlugin() {
  return {
    id: "weldall-browser-connections",
    init(context: Parameters<typeof extendOAuthProvider>[0]) {
      extendOAuthProvider(context, browserConnectionOAuthExtension);
    },
  } as const;
}

export async function issueBrowserDeviceTokens(
  input: { request: Request; body: unknown; provider: OAuthProviderApi },
  dependencies: BrowserIssuanceDependencies = {},
): Promise<OAuthTokenResponse> {
  const clientId = requiredBodyString(input.body, "client_id");
  const deviceCode = requiredBodyString(input.body, "device_code");
  const authenticated = await input.provider.authenticateClient({
    requireCredentials: false,
    scopes: [...BROWSER_INFRASTRUCTURE_SCOPES],
  });
  if (authenticated.clientId !== clientId || authenticated.client.clientId !== clientId)
    throw new WeldallAuthError("invalid_client");

  const pending = await pollBrowserConnectionRequest({
    request: input.request,
    deviceCode,
    browserClientId: clientId,
  });
  const attempt = await db.browserConnectionIssuanceAttempt.findUniqueOrThrow({
    where: { requestId: pending.id },
  });
  const userId = pending.approvedByUserId;
  if (!userId || !(await hasLoginScopeForUserId(userId)))
    throw new WeldallAuthError("invalid_grant");

  const connection = await db.$transaction(async (tx) => {
    await lockBrowserResourceLifecycle(tx);
    const current = await tx.browserConnectionRequest.findUnique({
      where: { id: pending.id },
      include: { resource: true, oauthClient: true },
    });
    const currentAttempt = await tx.browserConnectionIssuanceAttempt.findUnique({
      where: { requestId: pending.id },
    });
    const prefixes = current
      ? await tx.resourceRequestPrefix.findMany({
          where: { resourceId: current.resourceId },
          select: { urlPrefix: true },
        })
      : [];
    if (
      !current ||
      current.status !== "ISSUING" ||
      current.expiresAt <= new Date() ||
      current.browserClientId !== clientId ||
      current.dpopJkt !== pending.dpopJkt ||
      current.approvedByUserId !== userId ||
      !current.resource.enabled ||
      current.oauthClient.disabled ||
      current.oauthClient.referenceId !== current.resourceId ||
      !browserOriginsForResource({ ...current.resource, requestPrefixes: prefixes }).includes(
        current.origin,
      ) ||
      !currentAttempt ||
      currentAttempt.id !== attempt.id ||
      currentAttempt.status !== "CLAIMED"
    )
      throw new WeldallAuthError("invalid_grant");
    const existing = await tx.browserConnection.findUnique({
      where: { refreshFamilyId: currentAttempt.refreshFamilyId },
    });
    if (existing) return existing;
    const created = await tx.browserConnection.create({
      data: {
        providerReferenceId: current.id,
        browserClientId: current.browserClientId,
        oauthClientId: current.oauthClientId,
        resourceId: current.resourceId,
        resourceKey: current.resource.key,
        resourceIdentifier: current.resource.resourceIdentifier,
        origin: current.origin,
        userId,
        userReferenceId: userId,
        dpopJkt: current.dpopJkt,
        refreshFamilyId: currentAttempt.refreshFamilyId,
        approvedVia: "cli-code",
      },
    });
    await tx.browserConnectionIssuanceAttempt.update({
      where: { id: currentAttempt.id },
      data: { connectionId: created.id },
    });
    await tx.browserConnectionRequest.update({
      where: { id: current.id },
      data: { connectionId: created.id },
    });
    return created;
  }, BROWSER_LIFECYCLE_TRANSACTION_OPTIONS);

  let committed = false;
  try {
    await dependencies.killPoint?.("after-claim");
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user?.emailVerified) throw new WeldallAuthError("invalid_grant");
    const tokenResponse = await input.provider.issueTokens({
      client: authenticated.client,
      user,
      scopes: [...BROWSER_INFRASTRUCTURE_SCOPES],
      resources: [WELDALL_RESOURCE],
      originalResources: [WELDALL_RESOURCE],
      referenceId: connection.providerReferenceId,
      confirmation: { jkt: pending.dpopJkt },
      accessTokenClaims: {
        weldall_connection_id: connection.id,
        weldall_connection_origin: connection.origin,
        weldall_connection_resource: connection.resourceIdentifier,
      },
      idTokenClaims: { weldall_connection_id: connection.id },
    });
    // Covers a hard stop after provider persistence but before the local journal write.
    await dependencies.killPoint?.("after-provider-return");
    if (
      typeof tokenResponse.access_token !== "string" ||
      typeof tokenResponse.refresh_token !== "string" ||
      tokenResponse.token_type !== "DPoP"
    )
      throw new WeldallAuthError("server_error", "invalid provider token response", 500);
    const providerRefreshTokenHash = await input.provider.hashToken(
      tokenResponse.refresh_token,
      "refresh_token",
    );
    const providerAccessTokenHash = hash(tokenResponse.access_token);
    const providerRefresh = await db.oauthRefreshToken.findUnique({
      where: { token: providerRefreshTokenHash },
    });
    if (
      !providerRefresh ||
      providerRefresh.clientId !== clientId ||
      providerRefresh.userId !== userId ||
      providerRefresh.referenceId !== connection.providerReferenceId ||
      providerRefresh.revoked ||
      providerRefresh.rotatedAt ||
      confirmationJkt(providerRefresh.confirmation) !== pending.dpopJkt
    )
      throw new WeldallAuthError("server_error", "provider returned an unbound refresh", 500);
    await db.$transaction(async (tx) => {
      await lockBrowserResourceLifecycle(tx);
      const [currentConnection, changed] = await Promise.all([
        tx.browserConnection.findUnique({ where: { id: connection.id } }),
        tx.browserConnectionIssuanceAttempt.updateMany({
          where: { id: attempt.id, status: "CLAIMED", connectionId: connection.id },
          data: {
            status: "PROVIDER_ISSUED",
            providerAccessTokenHash,
            providerRefreshTokenHash,
            providerIssuedAt: new Date(),
          },
        }),
      ]);
      if (!currentConnection || currentConnection.state !== "ACTIVE" || changed.count !== 1)
        throw new WeldallAuthError("invalid_grant", "browser issuance was revoked");
    }, BROWSER_LIFECYCLE_TRANSACTION_OPTIONS);
    await dependencies.killPoint?.("after-provider-issuance");

    const expiresAt = new Date(Date.now() + BROWSER_REFRESH_LIFETIME_MS);
    await db.$transaction(async (tx) => {
      await lockBrowserResourceLifecycle(tx);
      const current = await tx.browserConnection.findUnique({ where: { id: connection.id } });
      const currentAttempt = await tx.browserConnectionIssuanceAttempt.findUnique({
        where: { id: attempt.id },
      });
      if (
        !current ||
        current.state !== "ACTIVE" ||
        !currentAttempt ||
        currentAttempt.status !== "PROVIDER_ISSUED" ||
        currentAttempt.connectionId !== current.id ||
        current.refreshFamilyId !== currentAttempt.refreshFamilyId
      )
        throw new WeldallAuthError("invalid_grant");
      await tx.oAuthDeviceRefreshBinding.create({
        data: {
          tokenHash: providerRefreshTokenHash,
          familyId: current.refreshFamilyId,
          clientId: current.browserClientId,
          userId: current.userId,
          dpopJkt: current.dpopJkt,
          browserConnectionId: current.id,
          expiresAt,
        },
      });
      await tx.browserConnectionIssuanceAttempt.update({
        where: { id: attempt.id },
        data: { status: "BINDING_CREATED", bindingCreatedAt: new Date() },
      });
    }, BROWSER_LIFECYCLE_TRANSACTION_OPTIONS);
    await dependencies.killPoint?.("after-binding");

    const identifiers = auditRequestIdentifiers(input.request);
    await db.$transaction(async (tx) => {
      await lockBrowserResourceLifecycle(tx);
      const committedAt = new Date();
      const requestUpdate = await tx.browserConnectionRequest.updateMany({
        where: {
          id: pending.id,
          status: "ISSUING",
          connectionId: connection.id,
          expiresAt: { gt: committedAt },
        },
        data: { status: "CONSUMED", consumedAt: committedAt },
      });
      const attemptUpdate = await tx.browserConnectionIssuanceAttempt.updateMany({
        where: { id: attempt.id, status: "BINDING_CREATED", connectionId: connection.id },
        data: { status: "COMMITTED", committedAt },
      });
      if (requestUpdate.count !== 1 || attemptUpdate.count !== 1)
        throw new WeldallAuthError("invalid_grant");
      await prismaAuditWriter.write(
        {
          eventType: "browser_connection.issued",
          actorType: "user",
          actorId: userId,
          actorEmail: user.email,
          clientId,
          ...identifiers,
          outcome: "success",
          subjectType: "browser_connection",
          subjectId: connection.id,
          metadata: {
            requestId: pending.id,
            browserClientId: clientId,
            origin: connection.origin,
            resourceId: pending.resourceId,
            resourceIdentifier: connection.resourceIdentifier,
            dpopJkt: connection.dpopJkt,
            expiresAt: expiresAt.toISOString(),
            cliSourceClient: "weldall-cli",
            approvedVia: "cli-code",
            connectionId: connection.id,
            refreshFamilyId: connection.refreshFamilyId,
          },
        },
        tx,
      );
    }, BROWSER_LIFECYCLE_TRANSACTION_OPTIONS);
    committed = true;
    await dependencies.killPoint?.("after-commit");
    await dependencies.killPoint?.("response-loss");
    return tokenResponse;
  } catch (error) {
    await reconcileBrowserIssuanceAttempt(pending.id, error, {
      revokeCommitted: committed,
    });
    throw error;
  }
}

/**
 * Revoke partial provider/local artifacts. Normal reconciliation leaves a
 * committed response valid. A caller that detects an after-commit/response-loss
 * failure sets revokeCommitted so the ambiguous provider and local family is
 * revoked without retaining raw token material.
 */
export async function reconcileBrowserIssuanceAttempt(
  requestId: string,
  cause: unknown = new Error("issuance_recovery"),
  options: { revokeCommitted?: boolean } = {},
): Promise<"committed" | "reconciled" | "missing"> {
  const snapshot = await db.browserConnectionIssuanceAttempt.findUnique({
    where: { requestId },
    include: { connection: true },
  });
  if (!snapshot) return "missing";
  if (snapshot.status === "COMMITTED" && !options.revokeCommitted) return "committed";
  const now = new Date();
  await db.$transaction(async (tx) => {
    await lockBrowserResourceLifecycle(tx);
    const attempt = await tx.browserConnectionIssuanceAttempt.findUnique({
      where: { requestId },
      include: { connection: true },
    });
    if (!attempt || (attempt.status === "COMMITTED" && !options.revokeCommitted)) return;
    const providerReferenceId = attempt.connection?.providerReferenceId ?? requestId;
    const revokedRefresh = await tx.oauthRefreshToken.updateMany({
      where: {
        OR: [
          { referenceId: providerReferenceId },
          ...(attempt.providerRefreshTokenHash
            ? [{ token: attempt.providerRefreshTokenHash }]
            : []),
        ],
        revoked: null,
      },
      data: { revoked: now },
    });
    const revokedAccess = await tx.oauthAccessToken.updateMany({
      where: {
        OR: [
          { referenceId: providerReferenceId },
          ...(attempt.providerAccessTokenHash ? [{ token: attempt.providerAccessTokenHash }] : []),
        ],
        revoked: null,
      },
      data: { revoked: now },
    });
    if (attempt.connection) {
      await tx.oAuthDeviceRefreshBinding.updateMany({
        where: { familyId: attempt.connection.refreshFamilyId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.browserConnection.updateMany({
        where: { id: attempt.connection.id, state: "ACTIVE" },
        data: {
          state: "REVOKED",
          revokedAt: now,
          revokedBy: "issuance-reconciler",
          revocationReason: "issuance_failed",
        },
      });
    }
    const wasFailed = attempt.status === "FAILED";
    await tx.browserConnectionIssuanceAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "FAILED",
        failedAt: attempt.failedAt ?? now,
        failureCode: `reconciled:${
          cause instanceof WeldallAuthError
            ? cause.code.slice(0, 170)
            : (attempt.failureCode?.replace(/^reconciled:/, "").slice(0, 170) ??
              "issuance_recovery")
        }`,
      },
    });
    await tx.browserConnectionRequest.updateMany({
      where: { id: requestId, status: "ISSUING" },
      data: { status: "DENIED", deniedAt: now },
    });
    const request = await tx.browserConnectionRequest.findUnique({
      where: { id: requestId },
      include: { resource: true },
    });
    if (request && (!wasFailed || revokedRefresh.count > 0 || revokedAccess.count > 0)) {
      await prismaAuditWriter.write(
        {
          eventType: "browser_connection.failed",
          actorType: "machine",
          actorId: "issuance-reconciler",
          clientId: request.browserClientId,
          requestId,
          outcome: "failed",
          reasonCode: "internal_error",
          subjectType: "browser_connection_request",
          subjectId: request.id,
          metadata: {
            stage: "issuance",
            requestId: request.id,
            connectionId: attempt.connection?.id ?? null,
            browserClientId: request.browserClientId,
            origin: request.origin,
            resourceIdentifier: request.resource.resourceIdentifier,
            dpopJkt: request.dpopJkt,
          },
        },
        tx,
      );
      if (attempt.connection)
        await prismaAuditWriter.write(
          {
            eventType: "browser_connection.revoked",
            actorType: "machine",
            actorId: "issuance-reconciler",
            clientId: attempt.connection.browserClientId,
            requestId,
            outcome: "success",
            subjectType: "browser_connection",
            subjectId: attempt.connection.id,
            metadata: {
              connectionId: attempt.connection.id,
              browserClientId: attempt.connection.browserClientId,
              origin: attempt.connection.origin,
              resourceId: attempt.connection.resourceId,
              resourceIdentifier: attempt.connection.resourceIdentifier,
              dpopJkt: attempt.connection.dpopJkt,
              approvedVia: attempt.connection.approvedVia,
              revocationReason: "issuance_failed",
            },
          },
          tx,
        );
    }
  }, BROWSER_LIFECYCLE_TRANSACTION_OPTIONS);
  return "reconciled";
}

export async function reconcileIncompleteBrowserIssuances(
  limit = 100,
  staleBefore = new Date(Date.now() - 60_000),
): Promise<number> {
  const take = Math.max(1, Math.min(limit, 500));
  const incomplete = await db.browserConnectionIssuanceAttempt.findMany({
    where: {
      status: { in: ["CLAIMED", "PROVIDER_ISSUED", "BINDING_CREATED"] },
      updatedAt: { lte: staleBefore },
    },
    orderBy: { updatedAt: "asc" },
    take,
    select: { requestId: true },
  });
  const remaining = take - incomplete.length;
  const failedWithLateProviderArtifacts = remaining
    ? await db.$queryRaw<{ requestId: string }[]>`
        SELECT DISTINCT attempt."requestId"
        FROM "BrowserConnectionIssuanceAttempt" AS attempt
        LEFT JOIN "OauthRefreshToken" AS refresh
          ON refresh."referenceId" = attempt."requestId" AND refresh."revoked" IS NULL
        LEFT JOIN "OauthAccessToken" AS access
          ON access."referenceId" = attempt."requestId" AND access."revoked" IS NULL
        WHERE attempt."status" = 'FAILED'
          AND (refresh."id" IS NOT NULL OR access."id" IS NOT NULL)
        ORDER BY attempt."requestId"
        LIMIT ${remaining}
      `
    : [];
  const requestIds = [
    ...incomplete.map(({ requestId }) => requestId),
    ...failedWithLateProviderArtifacts.map(({ requestId }) => requestId),
  ];
  for (const requestId of requestIds) await reconcileBrowserIssuanceAttempt(requestId);
  return requestIds.length;
}

/** Drain all fresh and stale issuance recovery work before accepting requests. */
export async function reconcileAllBrowserIssuancesAtStartup(batchSize = 100): Promise<number> {
  const size = Math.max(1, Math.min(batchSize, 500));
  let total = 0;
  for (;;) {
    const reconciled = await reconcileIncompleteBrowserIssuances(size, new Date());
    total += reconciled;
    if (reconciled < size) return total;
  }
}

export async function revokeBrowserConnectionFamily(
  tx: Prisma.TransactionClient,
  connectionId: string,
  input: { actorId: string; reason: string },
): Promise<boolean> {
  const connection = await tx.browserConnection.findUnique({
    where: { id: connectionId },
  });
  if (!connection) return false;
  const now = new Date();
  await tx.oAuthDeviceRefreshBinding.updateMany({
    where: { familyId: connection.refreshFamilyId, revokedAt: null },
    data: { revokedAt: now },
  });
  await tx.oauthRefreshToken.updateMany({
    where: { referenceId: connection.providerReferenceId, revoked: null },
    data: { revoked: now },
  });
  await tx.oauthAccessToken.updateMany({
    where: { referenceId: connection.providerReferenceId, revoked: null },
    data: { revoked: now },
  });
  const changed = await tx.browserConnection.updateMany({
    where: { id: connection.id, state: "ACTIVE" },
    data: {
      state: "REVOKED",
      revokedAt: now,
      revokedBy: input.actorId,
      revocationReason: input.reason,
    },
  });
  return changed.count === 1;
}

export { BROWSER_REFRESH_LIFETIME_MS };
