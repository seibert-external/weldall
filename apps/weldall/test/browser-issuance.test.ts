import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, ensureSystemScopes, LOGIN_SCOPE_KEY } from "@weldall/db";
import { createDpopProof, generateEs256KeyPair, type DpopKeyPair } from "@weldall/sdk";
import { createResource, deleteResource, updateResource } from "../src/server/admin/service.js";
import {
  cleanupBrowserConnectionState,
  decidePendingBrowserConnection,
  pollBrowserConnectionRequest,
  startBrowserDeviceAuthorization,
} from "../src/server/oauth/browser-connections.js";
import {
  issueBrowserDeviceTokens,
  reconcileAllBrowserIssuancesAtStartup,
  reconcileBrowserIssuanceAttempt,
  type BrowserIssuanceKillPoint,
} from "../src/server/oauth/browser-issuance.js";
import {
  currentBrowserConnectionStatus,
  revokeCurrentBrowserConnection,
  revokeBrowserConnections,
} from "../src/server/oauth/browser-sessions.js";
import { browserClientIdForResourceKey } from "../src/server/oauth/browser-resources.js";
import {
  WELDALL_ISSUER,
  WELDALL_RESOURCE,
  WELDALL_TOKEN_ENDPOINT,
} from "../src/server/oauth/constants.js";
import { signWeldallJwt } from "../src/server/oauth/jwt.js";
import { logger } from "../src/server/observability/logger.js";

const runId = randomUUID().replaceAll("-", "");
const userId = `browser-issuance-${runId}`;
const email = `${runId}@issuance.example`;
const key = `issuance-${runId}`;
const origin = `https://${key}.example`;
const resourceIdentifier = `${origin}/api`;
const clientId = browserClientIdForResourceKey(key);
const proxySecret = `browser-proxy-${runId}-secret-at-least-32-characters`;
let browserKey: DpopKeyPair;
let issuerKey: DpopKeyPair;
let resourceId: string;
let loginAssignmentId: string;
let businessScopeId: string;
let actualAccessToken = "";
let actualRefreshToken = "";
let rotatedActualRefreshToken = "";
let actualConnectionId = "";

const digest = (value: string) => createHash("sha256").update(value, "ascii").digest("base64url");

async function startAndApprove() {
  const startProof = await createDpopProof({
    ...browserKey,
    method: "POST",
    url: `${WELDALL_ISSUER}/api/auth/oauth2/device_authorization`,
  });
  const started = await startBrowserDeviceAuthorization(
    new Request(`${WELDALL_ISSUER}/api/auth/oauth2/device_authorization`, {
      method: "POST",
      headers: {
        origin,
        dpop: startProof,
        "content-type": "application/x-www-form-urlencoded",
        "x-weldall-proxy-attestation": proxySecret,
        "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: new URLSearchParams({ client_id: clientId, resource: resourceIdentifier }),
    }),
  );
  await decidePendingBrowserConnection(
    new Request(`${WELDALL_ISSUER}/approve`, { method: "POST" }),
    { id: userId, email },
    started.user_code,
    true,
  );
  return started;
}

function mockProvider() {
  return {
    authenticateClient: async () => ({
      clientId,
      client: await db.oauthClient.findUniqueOrThrow({ where: { clientId } }),
      method: "none",
    }),
    issueTokens: async (params: any) => {
      const refresh = `browser-refresh-${randomUUID()}`;
      const access = `browser-access-${randomUUID()}`;
      await db.oauthRefreshToken.create({
        data: {
          id: `provider-${randomUUID()}`,
          token: digest(refresh),
          clientId,
          userId,
          referenceId: params.referenceId,
          resources: [WELDALL_RESOURCE],
          expiresAt: new Date(Date.now() + 86_400_000),
          confirmation: JSON.stringify(params.confirmation),
          scopes: params.scopes,
        },
      });
      return {
        access_token: access,
        refresh_token: refresh,
        token_type: "DPoP" as const,
        expires_in: 300,
        expires_at: Math.floor(Date.now() / 1000) + 300,
        scope: params.scopes.join(" "),
        id_token: "identity-token",
      };
    },
    hashToken: async (token: string) => digest(token),
  } as any;
}

async function issueRealSession() {
  const started = await startAndApprove();
  const proof = await createDpopProof({
    ...browserKey,
    method: "POST",
    url: WELDALL_TOKEN_ENDPOINT,
  });
  const { tokenFacade } = await import("../src/server/oauth/facade.js");
  const response = await tokenFacade(
    new Request(WELDALL_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { origin, dpop: proof, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: started.device_code,
      }),
    }),
  );
  if (!response.ok) throw new Error(`real browser issuance failed: ${response.status}`);
  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };
  const pending = await db.browserConnectionRequest.findFirstOrThrow({
    where: { browserClientId: clientId, status: "CONSUMED" },
    orderBy: { createdAt: "desc" },
    include: { connection: true },
  });
  return { ...tokens, connection: pending.connection!, providerReferenceId: pending.id };
}

async function refreshResponse(refreshToken: string, requestOrigin = origin) {
  const proof = await createDpopProof({
    ...browserKey,
    method: "POST",
    url: WELDALL_TOKEN_ENDPOINT,
  });
  const { tokenFacade } = await import("../src/server/oauth/facade.js");
  return tokenFacade(
    new Request(WELDALL_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        origin: requestOrigin,
        dpop: proof,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    }),
  );
}

async function exchangeResponse(refreshToken: string, requestOrigin = origin) {
  const proof = await createDpopProof({
    ...browserKey,
    method: "POST",
    url: WELDALL_TOKEN_ENDPOINT,
  });
  const { tokenFacade } = await import("../src/server/oauth/facade.js");
  return tokenFacade(
    new Request(WELDALL_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        origin: requestOrigin,
        dpop: proof,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
        subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
        subject_token: refreshToken,
        client_id: clientId,
        resource: resourceIdentifier,
        audience: origin,
        scope: `${key}:read`,
      }),
    }),
  );
}

async function pollingRequest(accessToken?: string, url = WELDALL_TOKEN_ENDPOINT) {
  const proof = await createDpopProof({
    ...browserKey,
    method: "POST",
    url,
    ...(accessToken ? { accessToken } : {}),
  });
  return new Request(url, {
    method: "POST",
    headers: {
      origin,
      dpop: proof,
      ...(accessToken ? { authorization: `DPoP ${accessToken}` } : {}),
      "content-type": "application/x-www-form-urlencoded",
      "x-weldall-proxy-attestation": proxySecret,
      "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    },
  });
}

beforeAll(async () => {
  browserKey = await generateEs256KeyPair();
  issuerKey = await generateEs256KeyPair();
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: "browser-issuance-test-secret-at-least-32-characters",
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
    WELDALL_SIGNING_KID: `browser-issuance-${runId}`,
    OAUTH_PROXY_SECRET: "browser-issuance-oauth-proxy-secret-32-characters",
    ENABLE_DEV_LOGIN: "false",
    WELDALL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    GOOGLE_CLIENT_ID: "browser-issuance-google-client",
    GOOGLE_CLIENT_SECRET: "browser-issuance-google-secret",
    WELDALL_TRUSTED_PROXY_SECRET: proxySecret,
  });
  await ensureSystemScopes(db, userId);
  await db.user.create({
    data: { id: userId, name: "Browser issuance", email, emailVerified: true },
  });
  const login = await db.scope.findUniqueOrThrow({ where: { key: LOGIN_SCOPE_KEY } });
  const businessScope = await db.scope.create({
    data: {
      key: `${key}:read`,
      description: "Browser issuance test scope",
      createdBy: userId,
      updatedBy: userId,
    },
  });
  businessScopeId = businessScope.id;
  const assignment = await db.emailScopeAssignment.create({
    data: {
      normalizedEmail: email,
      createdBy: userId,
      updatedBy: userId,
      grants: {
        create: [login, businessScope].map((scope) => ({
          scopeId: scope.id,
          createdBy: userId,
        })),
      },
    },
  });
  loginAssignmentId = assignment.id;
  const resource = await createResource(
    {
      key,
      name: "Browser issuance resource",
      resourceIdentifier,
      authorizationServer: origin,
      downstreamClientId: `downstream-${runId}`,
      enabled: true,
      skillDiscoveryEnabled: false,
      scopeIds: [businessScope.id],
      requestPrefixes: [`${origin}/api`],
    },
    { id: userId, email, requestId: `setup-${runId}` },
  );
  resourceId = resource.id;
});

afterAll(async () => {
  await db.oAuthDeviceRefreshBinding.deleteMany({ where: { clientId } });
  await db.browserConnectionRequest.deleteMany({ where: { browserClientId: clientId } });
  await db.browserConnection.deleteMany({ where: { browserClientId: clientId } });
  await db.oauthRefreshToken.deleteMany({ where: { clientId } });
  await db.auditEvent.deleteMany({
    where: { OR: [{ actorId: userId }, { clientId }, { subjectId: resourceId }] },
  });
  await db.downstreamResource.deleteMany({ where: { id: resourceId } });
  await db.oauthClient.deleteMany({ where: { clientId } });
  await db.emailScopeAssignment.deleteMany({ where: { id: loginAssignmentId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.scope.deleteMany({ where: { id: businessScopeId } });
});

describe("browser provider issuance", () => {
  it("dispatches the RFC 8628 grant through the installed Better Auth extension", async () => {
    const started = await startAndApprove();
    const proof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          origin,
          dpop: proof,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: clientId,
          device_code: started.device_code,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token_type: string;
      access_token: string;
      refresh_token: string;
      id_token: string;
    };
    expect(body).toMatchObject({
      token_type: "DPoP",
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      id_token: expect.any(String),
    });
    actualAccessToken = body.access_token;
    actualRefreshToken = body.refresh_token;
    const consumed = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId, status: "CONSUMED" },
      orderBy: { createdAt: "desc" },
    });
    actualConnectionId = consumed.connectionId!;
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { eventType: "browser_connection.issued", subjectId: actualConnectionId },
    });
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain(body.access_token);
    expect(serializedAudit).not.toContain(body.refresh_token);
    expect(serializedAudit).not.toContain(body.id_token);
    expect(serializedAudit).not.toContain(proof);
  });

  it("rotates the browser refresh with a sliding lifetime and preserved connection binding", async () => {
    rotatedActualRefreshToken = actualRefreshToken;
    const oldHash = digest(actualRefreshToken);
    const proof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          origin,
          dpop: proof,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: actualRefreshToken,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string; refresh_token: string };
    const [oldBinding, nextBinding, connection] = await Promise.all([
      db.oAuthDeviceRefreshBinding.findUniqueOrThrow({ where: { tokenHash: oldHash } }),
      db.oAuthDeviceRefreshBinding.findUniqueOrThrow({
        where: { tokenHash: digest(body.refresh_token) },
      }),
      db.browserConnection.findUniqueOrThrow({ where: { id: actualConnectionId } }),
    ]);
    expect(oldBinding.rotatedAt).toBeInstanceOf(Date);
    expect(nextBinding).toMatchObject({
      familyId: oldBinding.familyId,
      browserConnectionId: actualConnectionId,
      clientId,
      userId,
      dpopJkt: browserKey.jkt,
    });
    expect(nextBinding.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(connection.lastUsedAt).toBeInstanceOf(Date);
    actualRefreshToken = body.refresh_token;
  });

  it("exchanges only for its own resource and evaluates business scopes live", async () => {
    const exchange = async (resource: string, audience: string) => {
      const proof = await createDpopProof({
        ...browserKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      const { tokenFacade } = await import("../src/server/oauth/facade.js");
      return tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            origin,
            dpop: proof,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
            subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
            subject_token: actualRefreshToken,
            client_id: clientId,
            resource,
            audience,
            scope: `${key}:read`,
          }),
        }),
      );
    };
    expect((await exchange(resourceIdentifier, origin)).status).toBe(200);
    const crossResource = await exchange(
      "https://expenses.seibert.localdev/api",
      "https://expenses.seibert.localdev",
    );
    expect(crossResource.status).toBe(400);
    await expect(crossResource.json()).resolves.toMatchObject({ error: "invalid_target" });
    await db.emailScopeGrant.deleteMany({
      where: { assignmentId: loginAssignmentId, scopeId: businessScopeId },
    });
    try {
      const denied = await exchange(resourceIdentifier, origin);
      expect(denied.status).toBe(400);
      await expect(denied.json()).resolves.toMatchObject({ error: "invalid_scope" });
    } finally {
      await db.emailScopeGrant.create({
        data: { assignmentId: loginAssignmentId, scopeId: businessScopeId, createdBy: userId },
      });
    }
  });

  it("authenticates browser discovery and restricts it to the connection resource", async () => {
    const scopesEndpoint = `${WELDALL_ISSUER}/api/me/scopes`;
    const scopesProof = await createDpopProof({
      ...browserKey,
      method: "GET",
      url: scopesEndpoint,
      accessToken: actualAccessToken,
    });
    const { GET: getScopes } = await import("../src/app/api/me/scopes/route.js");
    const scopesResponse = await getScopes(
      new Request(scopesEndpoint, {
        headers: {
          origin,
          authorization: `DPoP ${actualAccessToken}`,
          dpop: scopesProof,
        },
      }),
    );
    expect(scopesResponse.status).toBe(200);
    const registry = (await scopesResponse.json()) as { resourceIdentifier: string }[];
    expect(registry).toEqual([expect.objectContaining({ resourceIdentifier })]);
    expect(registry).not.toContainEqual(
      expect.objectContaining({ resourceIdentifier: "https://expenses.seibert.localdev/api" }),
    );

    const grantsEndpoint = `${WELDALL_ISSUER}/api/me/grants`;
    const grantsProof = await createDpopProof({
      ...browserKey,
      method: "GET",
      url: grantsEndpoint,
      accessToken: actualAccessToken,
    });
    const { GET: getGrants } = await import("../src/app/api/me/grants/route.js");
    const grantsResponse = await getGrants(
      new Request(grantsEndpoint, {
        headers: {
          origin,
          authorization: `DPoP ${actualAccessToken}`,
          dpop: grantsProof,
        },
      }),
    );
    expect(grantsResponse.status).toBe(200);
    await expect(grantsResponse.json()).resolves.toEqual([`${key}:read`]);
  });

  it("returns stable status errors for mismatched claims, proof, origin and live state", async () => {
    const connection = await db.browserConnection.findUniqueOrThrow({
      where: { id: actualConnectionId },
    });
    const statusUrl = `${WELDALL_ISSUER}/api/me/browser-connections/current`;
    const token = async (overrides: Record<string, unknown> = {}) => {
      const now = Math.floor(Date.now() / 1_000);
      return signWeldallJwt({
        iss: WELDALL_ISSUER,
        sub: userId,
        aud: WELDALL_RESOURCE,
        client_id: clientId,
        scope: "openid offline_access weldall:scopes",
        cnf: { jkt: browserKey.jkt },
        weldall_connection_id: connection.id,
        weldall_connection_origin: connection.origin,
        weldall_connection_resource: connection.resourceIdentifier,
        iat: now,
        exp: now + 300,
        ...overrides,
      });
    };
    const authenticate = async (
      accessToken: string,
      requestOrigin = origin,
      proofKey = browserKey,
    ) => {
      const proof = await createDpopProof({
        ...proofKey,
        method: "GET",
        url: statusUrl,
        accessToken,
      });
      return currentBrowserConnectionStatus(
        new Request(statusUrl, {
          headers: {
            origin: requestOrigin,
            authorization: `DPoP ${accessToken}`,
            dpop: proof,
          },
        }),
        statusUrl,
      );
    };
    await expect(authenticate(await token({ azp: "wrong-client" }))).rejects.toMatchObject({
      code: "invalid_token",
    });
    await expect(authenticate(await token({ client_id: "weldall-cli" }))).rejects.toMatchObject({
      code: "invalid_token",
    });
    await expect(authenticate(await token({ sub: "wrong-subject" }))).rejects.toMatchObject({
      code: "browser_connection_invalid",
    });
    await expect(
      authenticate(await token({ weldall_connection_id: `missing-${runId}` })),
    ).rejects.toMatchObject({ code: "browser_connection_invalid" });
    await expect(authenticate(await token(), "https://other.example")).rejects.toMatchObject({
      code: "browser_connection_invalid",
    });
    const attacker = await generateEs256KeyPair();
    await expect(authenticate(await token(), origin, attacker)).rejects.toMatchObject({
      code: "invalid_dpop_proof",
    });
    const now = Math.floor(Date.now() / 1_000);
    await expect(
      authenticate(await token({ iat: now - 600, exp: now - 300 })),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await db.oauthClient.update({ where: { clientId }, data: { disabled: true } });
    try {
      await expect(authenticate(await token())).rejects.toMatchObject({
        code: "browser_connection_origin_changed",
      });
    } finally {
      await db.oauthClient.update({ where: { clientId }, data: { disabled: false } });
    }
    await db.downstreamResource.update({ where: { id: resourceId }, data: { enabled: false } });
    try {
      await expect(authenticate(await token())).rejects.toMatchObject({
        code: "browser_connection_origin_changed",
      });
    } finally {
      await db.downstreamResource.update({ where: { id: resourceId }, data: { enabled: true } });
    }
  });

  it("durably links one provider family, connection, binding and consumed request", async () => {
    const started = await startAndApprove();
    const result = await issueBrowserDeviceTokens({
      request: await pollingRequest(),
      body: { client_id: clientId, device_code: started.device_code },
      provider: mockProvider(),
    });
    expect(result).toMatchObject({ token_type: "DPoP", refresh_token: expect.any(String) });
    const request = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId, status: "CONSUMED" },
      orderBy: { createdAt: "desc" },
      include: { connection: true, issuanceAttempt: true },
    });
    expect(request.connection).toMatchObject({
      browserClientId: clientId,
      userId,
      dpopJkt: browserKey.jkt,
      state: "ACTIVE",
    });
    expect(request.issuanceAttempt).toMatchObject({ status: "COMMITTED" });
    await expect(
      db.oAuthDeviceRefreshBinding.findUniqueOrThrow({
        where: { tokenHash: digest(result.refresh_token!) },
      }),
    ).resolves.toMatchObject({
      browserConnectionId: request.connection!.id,
      familyId: request.connection!.refreshFamilyId,
      clientId,
      userId,
      dpopJkt: browserKey.jkt,
    });
  });

  it("retains active consumed recovery state until revocation cleanup", async () => {
    const started = await startAndApprove();
    const result = await issueBrowserDeviceTokens({
      request: await pollingRequest(),
      body: { client_id: clientId, device_code: started.device_code },
      provider: mockProvider(),
    });
    const pending = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId, status: "CONSUMED" },
      orderBy: { createdAt: "desc" },
      include: { connection: true },
    });
    const connection = pending.connection!;
    const old = new Date(Date.now() - 2 * 86_400_000);
    await db.$executeRaw`
      UPDATE "BrowserConnectionRequest" SET "updatedAt" = ${old} WHERE "id" = ${pending.id}
    `;
    await cleanupBrowserConnectionState();
    await expect(
      db.browserConnectionRequest.findUnique({ where: { id: pending.id } }),
    ).resolves.toMatchObject({ status: "CONSUMED", connectionId: connection.id });
    await expect(
      db.browserConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({ providerReferenceId: pending.id, state: "ACTIVE" });

    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const refreshProof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const refreshed = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          origin,
          dpop: refreshProof,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: result.refresh_token!,
        }),
      }),
    );
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as { refresh_token: string };
    const exchangeProof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const exchanged = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          origin,
          dpop: exchangeProof,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
          subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
          subject_token: rotated.refresh_token,
          client_id: clientId,
          resource: resourceIdentifier,
          audience: origin,
          scope: `${key}:read`,
        }),
      }),
    );
    expect(exchanged.status).toBe(200);
    await revokeBrowserConnections(
      { connectionId: connection.id },
      { id: "cleanup-admin", requestId: `cleanup-${runId}` },
    );
    expect(
      await db.oauthRefreshToken.count({
        where: { referenceId: pending.id, revoked: null },
      }),
    ).toBe(0);
    await db.$executeRaw`
      UPDATE "BrowserConnectionRequest" SET "updatedAt" = ${old} WHERE "id" = ${pending.id}
    `;
    await cleanupBrowserConnectionState();
    await expect(
      db.browserConnectionRequest.findUnique({ where: { id: pending.id } }),
    ).resolves.toBeNull();
  });

  for (const point of [
    "after-claim",
    "after-provider-return",
    "after-provider-issuance",
    "after-binding",
  ] as const) {
    it(`reconciles the ${point} crash boundary without leaving an active family`, async () => {
      const started = await startAndApprove();
      await expect(
        issueBrowserDeviceTokens(
          {
            request: await pollingRequest(),
            body: { client_id: clientId, device_code: started.device_code },
            provider: mockProvider(),
          },
          {
            killPoint: (current: BrowserIssuanceKillPoint) => {
              if (current === point) throw new Error(`kill:${point}`);
            },
          },
        ),
      ).rejects.toThrow(`kill:${point}`);
      const request = await db.browserConnectionRequest.findFirstOrThrow({
        where: { browserClientId: clientId },
        orderBy: { createdAt: "desc" },
        include: { connection: true, issuanceAttempt: true },
      });
      expect(request.issuanceAttempt?.status).toBe("FAILED");
      expect(request.connection?.state).toBe("REVOKED");
      expect(
        await db.oAuthDeviceRefreshBinding.count({
          where: { familyId: request.issuanceAttempt!.refreshFamilyId, revokedAt: null },
        }),
      ).toBe(0);
      expect(
        await db.oauthRefreshToken.count({
          where: { referenceId: request.id, revoked: null },
        }),
      ).toBe(0);
      expect(await reconcileBrowserIssuanceAttempt(request.id)).toBe("reconciled");
    });
  }

  for (const point of ["after-commit", "response-loss"] as const) {
    it(`treats ${point} as one consumed family and never reissues`, async () => {
      const started = await startAndApprove();
      await expect(
        issueBrowserDeviceTokens(
          {
            request: await pollingRequest(),
            body: { client_id: clientId, device_code: started.device_code },
            provider: mockProvider(),
          },
          {
            killPoint: (current) => {
              if (current === point) throw new Error(`kill:${point}`);
            },
          },
        ),
      ).rejects.toThrow(`kill:${point}`);
      const request = await db.browserConnectionRequest.findFirstOrThrow({
        where: { browserClientId: clientId },
        orderBy: { createdAt: "desc" },
        include: { connection: true, issuanceAttempt: true },
      });
      expect(request.status).toBe("CONSUMED");
      expect(request.issuanceAttempt?.status).toBe("FAILED");
      expect(request.connection?.state).toBe("REVOKED");
      expect(await reconcileBrowserIssuanceAttempt(request.id)).toBe("reconciled");
      expect(
        await db.browserConnection.count({
          where: { refreshFamilyId: request.connection!.refreshFamilyId },
        }),
      ).toBe(1);
      expect(
        await db.oAuthDeviceRefreshBinding.count({
          where: { familyId: request.connection!.refreshFamilyId, revokedAt: null },
        }),
      ).toBe(0);
    });
  }

  for (const durableState of [
    "CLAIMED",
    "PROVIDER_ISSUED",
    "BINDING_CREATED",
    "COMMITTED",
  ] as const) {
    it(`recovers a process-death ${durableState} issuance without relying on the request catch`, async () => {
      const started = await startAndApprove();
      const pending = await pollBrowserConnectionRequest({
        request: await pollingRequest(),
        deviceCode: started.device_code,
        browserClientId: clientId,
      });
      const attempt = await db.browserConnectionIssuanceAttempt.findUniqueOrThrow({
        where: { requestId: pending.id },
      });
      let connectionId: string | undefined;
      const providerToken = `process-death-${durableState}-${randomUUID()}`;
      if (durableState !== "CLAIMED") {
        const connection = await db.browserConnection.create({
          data: {
            providerReferenceId: pending.id,
            browserClientId: clientId,
            oauthClientId: clientId,
            resourceId,
            resourceKey: key,
            resourceIdentifier,
            origin,
            userId,
            userReferenceId: userId,
            dpopJkt: browserKey.jkt,
            refreshFamilyId: attempt.refreshFamilyId,
            approvedVia: "cli-code",
          },
        });
        connectionId = connection.id;
        await db.browserConnectionRequest.update({
          where: { id: pending.id },
          data: { connectionId },
        });
        await db.browserConnectionIssuanceAttempt.update({
          where: { id: attempt.id },
          data: {
            connectionId,
            status: durableState,
            ...(durableState === "PROVIDER_ISSUED" ? { providerIssuedAt: new Date() } : {}),
            ...(durableState === "BINDING_CREATED" || durableState === "COMMITTED"
              ? { providerIssuedAt: new Date(), bindingCreatedAt: new Date() }
              : {}),
            ...(durableState === "COMMITTED" ? { committedAt: new Date() } : {}),
            providerRefreshTokenHash: digest(providerToken),
          },
        });
        await db.oauthRefreshToken.create({
          data: {
            id: `process-provider-${randomUUID()}`,
            token: digest(providerToken),
            clientId,
            userId,
            referenceId: pending.id,
            resources: [WELDALL_RESOURCE],
            expiresAt: new Date(Date.now() + 60_000),
            confirmation: JSON.stringify({ jkt: browserKey.jkt }),
            scopes: ["openid", "offline_access", "weldall:scopes"],
          },
        });
        await db.oauthAccessToken.create({
          data: {
            id: `process-access-${randomUUID()}`,
            token: digest(`${providerToken}-access`),
            clientId,
            userId,
            referenceId: pending.id,
            resources: [WELDALL_RESOURCE],
            expiresAt: new Date(Date.now() + 60_000),
            confirmation: JSON.stringify({ jkt: browserKey.jkt }),
            scopes: ["openid", "weldall:scopes"],
          },
        });
        if (durableState === "BINDING_CREATED" || durableState === "COMMITTED")
          await db.oAuthDeviceRefreshBinding.create({
            data: {
              tokenHash: digest(providerToken),
              familyId: attempt.refreshFamilyId,
              clientId,
              userId,
              dpopJkt: browserKey.jkt,
              browserConnectionId: connection.id,
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
        if (durableState === "COMMITTED")
          await db.browserConnectionRequest.update({
            where: { id: pending.id },
            data: { status: "CONSUMED", consumedAt: new Date() },
          });
      }

      if (durableState === "COMMITTED") {
        await expect(
          pollBrowserConnectionRequest({
            request: new Request(WELDALL_TOKEN_ENDPOINT, {
              method: "POST",
              headers: { origin },
            }),
            deviceCode: started.device_code,
            browserClientId: clientId,
          }),
        ).rejects.toMatchObject({ code: "invalid_dpop_proof" });
        await expect(
          pollBrowserConnectionRequest({
            request: await pollingRequest(),
            deviceCode: `wrong-${randomUUID()}`,
            browserClientId: clientId,
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });

        const attacker = await generateEs256KeyPair();
        const attackerProof = await createDpopProof({
          ...attacker,
          method: "POST",
          url: WELDALL_TOKEN_ENDPOINT,
        });
        await expect(
          pollBrowserConnectionRequest({
            request: new Request(WELDALL_TOKEN_ENDPOINT, {
              method: "POST",
              headers: { origin, dpop: attackerProof },
            }),
            deviceCode: started.device_code,
            browserClientId: clientId,
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
        await expect(
          db.browserConnection.findUniqueOrThrow({ where: { id: connectionId! } }),
        ).resolves.toMatchObject({ state: "ACTIVE" });
        expect(
          await db.oauthRefreshToken.count({ where: { referenceId: pending.id, revoked: null } }),
        ).toBe(1);
        await db.browserConnectionRequest.update({
          where: { id: pending.id },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        });
        await cleanupBrowserConnectionState(new Date(Date.now() + 2 * 86_400_000));
        await expect(
          db.browserConnectionRequest.findUnique({ where: { id: pending.id } }),
        ).resolves.not.toBeNull();

        // A fresh valid proof from the pre-bound browser key is a retry after an
        // unknowable response-delivery boundary. It revokes only this family.
        await expect(
          pollBrowserConnectionRequest({
            request: await pollingRequest(),
            deviceCode: started.device_code,
            browserClientId: clientId,
          }),
        ).rejects.toMatchObject({ code: "invalid_grant" });
      } else await reconcileAllBrowserIssuancesAtStartup(2);

      await expect(
        db.browserConnectionIssuanceAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      ).resolves.toMatchObject({ status: "FAILED" });
      expect(
        await db.oauthRefreshToken.count({ where: { referenceId: pending.id, revoked: null } }),
      ).toBe(0);
      expect(
        await db.oauthAccessToken.count({ where: { referenceId: pending.id, revoked: null } }),
      ).toBe(0);
      expect(
        await db.oAuthDeviceRefreshBinding.count({
          where: { familyId: attempt.refreshFamilyId, revokedAt: null },
        }),
      ).toBe(0);
      if (connectionId)
        await expect(
          db.browserConnection.findUniqueOrThrow({ where: { id: connectionId } }),
        ).resolves.toMatchObject({ state: "REVOKED" });
    });
  }

  it("reconciles provider tokens persisted after a lifecycle failure tombstone", async () => {
    const started = await startAndApprove();
    const pending = await pollBrowserConnectionRequest({
      request: await pollingRequest(),
      deviceCode: started.device_code,
      browserClientId: clientId,
    });
    const attempt = await db.browserConnectionIssuanceAttempt.findUniqueOrThrow({
      where: { requestId: pending.id },
    });
    await db.browserConnectionIssuanceAttempt.update({
      where: { id: attempt.id },
      data: { status: "FAILED", failedAt: new Date(), failureCode: "origin_removed" },
    });
    await db.browserConnectionRequest.update({
      where: { id: pending.id },
      data: { status: "DENIED", deniedAt: new Date() },
    });
    const lateToken = `late-provider-${randomUUID()}`;
    await db.oauthRefreshToken.create({
      data: {
        id: `late-provider-${randomUUID()}`,
        token: digest(lateToken),
        clientId,
        userId,
        referenceId: pending.id,
        resources: [WELDALL_RESOURCE],
        expiresAt: new Date(Date.now() + 60_000),
        confirmation: JSON.stringify({ jkt: browserKey.jkt }),
        scopes: ["openid", "offline_access", "weldall:scopes"],
      },
    });
    await reconcileAllBrowserIssuancesAtStartup(1);
    await expect(
      db.oauthRefreshToken.findUniqueOrThrow({ where: { token: digest(lateToken) } }),
    ).resolves.toEqual(expect.objectContaining({ revoked: expect.any(Date) }));
    await expect(
      db.browserConnectionIssuanceAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ status: "FAILED", failureCode: "reconciled:origin_removed" });
  });

  it("authenticates current status with the real provider token and remotely revokes idempotently", async () => {
    const started = await startAndApprove();
    const proof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const issued = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { origin, dpop: proof, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: clientId,
          device_code: started.device_code,
        }),
      }),
    );
    expect(issued.status).toBe(200);
    const tokens = (await issued.json()) as { access_token: string };
    const connection = await db.browserConnection.findUniqueOrThrow({
      where: {
        providerReferenceId: (
          await db.browserConnectionRequest.findFirstOrThrow({
            where: { browserClientId: clientId, status: "CONSUMED" },
            orderBy: { createdAt: "desc" },
          })
        ).id,
      },
    });
    const statusUrl = `${WELDALL_ISSUER}/api/me/browser-connections/current`;
    const statusProof = await createDpopProof({
      ...browserKey,
      method: "GET",
      url: statusUrl,
      accessToken: tokens.access_token,
    });
    const verified = await currentBrowserConnectionStatus(
      new Request(statusUrl, {
        method: "GET",
        headers: {
          origin,
          authorization: `DPoP ${tokens.access_token}`,
          dpop: statusProof,
        },
      }),
      statusUrl,
    );
    expect(verified).toMatchObject({ id: connection.id, state: "active", subject: userId });

    const revokeUrl = `${statusUrl}/revoke`;
    const revoke = async () => {
      const revokeProof = await createDpopProof({
        ...browserKey,
        method: "POST",
        url: revokeUrl,
        accessToken: tokens.access_token,
      });
      return revokeCurrentBrowserConnection(
        new Request(revokeUrl, {
          method: "POST",
          headers: {
            origin,
            authorization: `DPoP ${tokens.access_token}`,
            dpop: revokeProof,
          },
        }),
        revokeUrl,
      );
    };
    await expect(revoke()).resolves.toEqual({ revoked: true, connectionId: connection.id });
    await expect(revoke()).resolves.toEqual({ revoked: true, connectionId: connection.id });
    await expect(
      db.browserConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({ state: "REVOKED" });
    const revokedProof = await createDpopProof({
      ...browserKey,
      method: "GET",
      url: statusUrl,
      accessToken: tokens.access_token,
    });
    await expect(
      currentBrowserConnectionStatus(
        new Request(statusUrl, {
          headers: {
            origin,
            authorization: `DPoP ${tokens.access_token}`,
            dpop: revokedProof,
          },
        }),
        statusUrl,
      ),
    ).rejects.toMatchObject({ code: "browser_connection_revoked" });
  });

  it("blocks browser refresh for a mismatched origin or disabled source resource", async () => {
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const refresh = async (requestOrigin: string) => {
      const proof = await createDpopProof({
        ...browserKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      return tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            origin: requestOrigin,
            dpop: proof,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: actualRefreshToken,
          }),
        }),
      );
    };
    expect((await refresh("https://attacker.example")).status).toBe(400);
    await db.downstreamResource.update({ where: { id: resourceId }, data: { enabled: false } });
    try {
      const disabled = await refresh(origin);
      expect(disabled.status).toBe(400);
      await expect(disabled.json()).resolves.toMatchObject({ error: "invalid_grant" });
    } finally {
      await db.downstreamResource.update({ where: { id: resourceId }, data: { enabled: true } });
    }
  });

  it("requires a valid bound proof before obsolete-refresh family revocation", async () => {
    const attacker = await generateEs256KeyPair();
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const request = async (keyPair: DpopKeyPair) => {
      const proof = await createDpopProof({
        ...keyPair,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      return tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            origin,
            dpop: proof,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: rotatedActualRefreshToken,
          }),
        }),
      );
    };
    const oldBinding = await db.oAuthDeviceRefreshBinding.findUniqueOrThrow({
      where: { tokenHash: digest(rotatedActualRefreshToken) },
    });
    const invalid = await request(attacker);
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });
    expect(
      await db.oAuthDeviceRefreshBinding.count({
        where: { familyId: oldBinding.familyId, revokedAt: { not: null } },
      }),
    ).toBe(0);
    const valid = await request(browserKey);
    expect(valid.status).toBe(400);
    expect(
      await db.oAuthDeviceRefreshBinding.count({
        where: { familyId: oldBinding.familyId, revokedAt: null },
      }),
    ).toBe(0);
    const currentProof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const currentAfterRevocation = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          origin,
          dpop: currentProof,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: actualRefreshToken,
        }),
      }),
    );
    expect(currentAfterRevocation.status).toBe(400);
  });

  it("authenticates the real user list/revoke route and limits revocation to the caller", async () => {
    const session = await issueRealSession();
    const now = Math.floor(Date.now() / 1_000);
    const cliToken = await signWeldallJwt({
      iss: WELDALL_ISSUER,
      sub: userId,
      aud: WELDALL_RESOURCE,
      client_id: "weldall-cli",
      scope: "weldall:scopes",
      cnf: { jkt: browserKey.jkt },
      iat: now,
      exp: now + 300,
    });
    const endpoint = `${WELDALL_ISSUER}/api/me/browser-connections`;
    const { GET, POST } = await import("../src/app/api/me/browser-connections/route.js");
    const getProof = await createDpopProof({
      ...browserKey,
      method: "GET",
      url: endpoint,
      accessToken: cliToken,
    });
    const listed = await GET(
      new Request(endpoint, {
        headers: { authorization: `DPoP ${cliToken}`, dpop: getProof },
      }),
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ id: session.connection.id, subject: userId }),
        ]),
      }),
    );
    const postProof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: endpoint,
      accessToken: cliToken,
    });
    const revoked = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: {
          authorization: `DPoP ${cliToken}`,
          dpop: postProof,
          "content-type": "application/json",
        },
        body: JSON.stringify({ connectionId: session.connection.id }),
      }),
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ revoked: 1 });
    expect(
      await db.oauthRefreshToken.count({
        where: { referenceId: session.providerReferenceId, revoked: null },
      }),
    ).toBe(0);
  });

  it("blocks refresh and exchange after login, connection, resource and origin revocation", async () => {
    const assertBlocked = async (refreshToken: string) => {
      expect((await refreshResponse(refreshToken)).status).toBe(400);
      expect((await exchangeResponse(refreshToken)).status).toBe(400);
    };

    const loginSession = await issueRealSession();
    await db.emailScopeGrant.deleteMany({
      where: { assignmentId: loginAssignmentId, scopeId: { not: businessScopeId } },
    });
    try {
      await assertBlocked(loginSession.refresh_token);
    } finally {
      const login = await db.scope.findUniqueOrThrow({ where: { key: LOGIN_SCOPE_KEY } });
      await db.emailScopeGrant.upsert({
        where: {
          assignmentId_scopeId: { assignmentId: loginAssignmentId, scopeId: login.id },
        },
        create: { assignmentId: loginAssignmentId, scopeId: login.id, createdBy: userId },
        update: {},
      });
    }

    const revokedSession = await issueRealSession();
    await revokeBrowserConnections(
      { connectionId: revokedSession.connection.id },
      { id: "revocation-admin", requestId: `connection-revoke-${runId}` },
    );
    await assertBlocked(revokedSession.refresh_token);

    const disabledSession = await issueRealSession();
    let resource = await db.downstreamResource.findUniqueOrThrow({ where: { id: resourceId } });
    const mutationActor = { id: userId, email, requestId: `live-policy-${runId}` };
    const disabled = await updateResource(
      {
        id: resource.id,
        name: resource.name,
        authorizationServer: resource.authorizationServer,
        downstreamClientId: resource.downstreamClientId,
        enabled: false,
        skillDiscoveryEnabled: resource.skillDiscoveryEnabled,
        scopeIds: [businessScopeId],
        requestPrefixes: [`${origin}/api`],
        expectedVersion: resource.version,
      },
      mutationActor,
    );
    await assertBlocked(disabledSession.refresh_token);
    await updateResource(
      {
        id: disabled.id,
        name: disabled.name,
        authorizationServer: origin,
        downstreamClientId: disabled.downstreamClientId,
        enabled: true,
        skillDiscoveryEnabled: disabled.skillDiscoveryEnabled,
        scopeIds: [businessScopeId],
        requestPrefixes: [`${origin}/api`],
        expectedVersion: disabled.version,
      },
      mutationActor,
    );

    const originSession = await issueRealSession();
    resource = await db.downstreamResource.findUniqueOrThrow({ where: { id: resourceId } });
    const moved = `https://moved-${key}.example`;
    const movedResource = await updateResource(
      {
        id: resource.id,
        name: resource.name,
        authorizationServer: moved,
        downstreamClientId: resource.downstreamClientId,
        enabled: true,
        skillDiscoveryEnabled: resource.skillDiscoveryEnabled,
        scopeIds: [businessScopeId],
        requestPrefixes: [`${moved}/api`],
        expectedVersion: resource.version,
      },
      mutationActor,
    );
    await assertBlocked(originSession.refresh_token);
    await updateResource(
      {
        id: movedResource.id,
        name: movedResource.name,
        authorizationServer: origin,
        downstreamClientId: movedResource.downstreamClientId,
        enabled: true,
        skillDiscoveryEnabled: movedResource.skillDiscoveryEnabled,
        scopeIds: [businessScopeId],
        requestPrefixes: [`${origin}/api`],
        expectedVersion: movedResource.version,
      },
      mutationActor,
    );
  });

  it("keeps actual browser protocol route logs and audits free of every credential", async () => {
    const records: unknown[] = [];
    const detach = logger.attachTransport((record) => records.push(record));
    const proofs: string[] = [];
    try {
      const deviceEndpoint = `${WELDALL_ISSUER}/api/auth/oauth2/device_authorization`;
      const startProof = await createDpopProof({
        ...browserKey,
        method: "POST",
        url: deviceEndpoint,
      });
      proofs.push(startProof);
      const { POST: startRoute } =
        await import("../src/app/api/auth/oauth2/device_authorization/route.js");
      const startedResponse = await startRoute(
        new Request(deviceEndpoint, {
          method: "POST",
          headers: {
            origin,
            dpop: startProof,
            "content-type": "application/x-www-form-urlencoded",
            "x-weldall-proxy-attestation": proxySecret,
            "x-forwarded-for": "198.51.100.222",
          },
          body: new URLSearchParams({ client_id: clientId, resource: resourceIdentifier }),
        }),
      );
      const started = (await startedResponse.json()) as {
        device_code: string;
        user_code: string;
      };
      await decidePendingBrowserConnection(
        new Request(`${WELDALL_ISSUER}/approve`, { method: "POST" }),
        { id: userId, email },
        started.user_code,
        true,
      );
      const tokenProof = await createDpopProof({
        ...browserKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      proofs.push(tokenProof);
      const { POST: tokenRoute } = await import("../src/app/api/auth/oauth2/token/route.js");
      const issuedResponse = await tokenRoute(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            origin,
            dpop: tokenProof,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: clientId,
            device_code: started.device_code,
          }),
        }),
      );
      expect(issuedResponse.status).toBe(200);
      const issued = (await issuedResponse.json()) as {
        access_token: string;
        refresh_token: string;
        id_token: string;
      };
      const refreshProof = await createDpopProof({
        ...browserKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      proofs.push(refreshProof);
      const refreshedResponse = await tokenRoute(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            origin,
            dpop: refreshProof,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: issued.refresh_token,
          }),
        }),
      );
      const refreshed = (await refreshedResponse.json()) as {
        access_token: string;
        refresh_token: string;
        id_token: string;
      };
      const exchangeProof = await createDpopProof({
        ...browserKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      proofs.push(exchangeProof);
      const exchangedResponse = await tokenRoute(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            origin,
            dpop: exchangeProof,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
            subject_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
            subject_token: refreshed.refresh_token,
            client_id: clientId,
            resource: resourceIdentifier,
            audience: origin,
            scope: `${key}:read`,
          }),
        }),
      );
      const exchanged = (await exchangedResponse.json()) as { access_token: string };
      const statusEndpoint = `${WELDALL_ISSUER}/api/me/browser-connections/current`;
      const statusProof = await createDpopProof({
        ...browserKey,
        method: "GET",
        url: statusEndpoint,
        accessToken: refreshed.access_token,
      });
      proofs.push(statusProof);
      const { GET: statusRoute } =
        await import("../src/app/api/me/browser-connections/current/route.js");
      const status = await statusRoute(
        new Request(statusEndpoint, {
          headers: {
            origin,
            authorization: `DPoP ${refreshed.access_token}`,
            dpop: statusProof,
          },
        }),
      );
      expect(status.status).toBe(200);
      const revokeEndpoint = `${statusEndpoint}/revoke`;
      const revokeProof = await createDpopProof({
        ...browserKey,
        method: "POST",
        url: revokeEndpoint,
        accessToken: refreshed.access_token,
      });
      proofs.push(revokeProof);
      const { POST: revokeRoute } =
        await import("../src/app/api/me/browser-connections/current/revoke/route.js");
      const revoked = await revokeRoute(
        new Request(revokeEndpoint, {
          method: "POST",
          headers: {
            origin,
            authorization: `DPoP ${refreshed.access_token}`,
            dpop: revokeProof,
          },
        }),
      );
      expect(revoked.status).toBe(200);
      const credentials = [
        started.device_code,
        started.user_code,
        issued.access_token,
        issued.refresh_token,
        issued.id_token,
        refreshed.access_token,
        refreshed.refresh_token,
        refreshed.id_token,
        exchanged.access_token,
        ...proofs,
        `DPoP ${refreshed.access_token}`,
      ];
      const serialized = JSON.stringify({
        records,
        audit: await db.auditEvent.findMany({
          where: { clientId, occurredAt: { gte: new Date(Date.now() - 60_000) } },
        }),
      });
      for (const credential of credentials) expect(serialized).not.toContain(credential);
    } finally {
      detach();
    }
  });

  it("atomically revokes provider and local families by connection, origin, resource and user", async () => {
    const makeFamily = async () => {
      const providerReferenceId = `bulk-reference-${randomUUID()}`;
      const familyId = `bulk-${randomUUID()}`;
      const rawToken = `bulk-token-${randomUUID()}`;
      const connection = await db.browserConnection.create({
        data: {
          providerReferenceId,
          browserClientId: clientId,
          oauthClientId: clientId,
          resourceId,
          resourceKey: key,
          resourceIdentifier,
          origin,
          userId,
          userReferenceId: userId,
          dpopJkt: browserKey.jkt,
          refreshFamilyId: familyId,
          approvedVia: "cli-code",
        },
      });
      await db.oAuthDeviceRefreshBinding.create({
        data: {
          tokenHash: digest(rawToken),
          familyId,
          clientId,
          userId,
          dpopJkt: browserKey.jkt,
          browserConnectionId: connection.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await db.oauthRefreshToken.create({
        data: {
          id: `bulk-provider-${randomUUID()}`,
          token: digest(rawToken),
          clientId,
          userId,
          referenceId: providerReferenceId,
          resources: [WELDALL_RESOURCE],
          expiresAt: new Date(Date.now() + 60_000),
          confirmation: JSON.stringify({ jkt: browserKey.jkt }),
          scopes: ["openid", "offline_access", "weldall:scopes"],
        },
      });
      return { connection, providerReferenceId, familyId };
    };
    for (const selector of ["connection", "origin", "resource", "user"] as const) {
      const family = await makeFamily();
      const input =
        selector === "connection"
          ? { connectionId: family.connection.id }
          : selector === "origin"
            ? { origin }
            : selector === "resource"
              ? { resourceId }
              : { userId };
      const result = await revokeBrowserConnections(input, {
        id: "admin-test",
        email: "admin@example.com",
        requestId: `bulk-${selector}-${runId}`,
      });
      expect(result.revoked).toBeGreaterThanOrEqual(1);
      await expect(
        db.browserConnection.findUniqueOrThrow({ where: { id: family.connection.id } }),
      ).resolves.toMatchObject({ state: "REVOKED" });
      expect(
        await db.oAuthDeviceRefreshBinding.count({
          where: { familyId: family.familyId, revokedAt: null },
        }),
      ).toBe(0);
      expect(
        await db.oauthRefreshToken.count({
          where: { referenceId: family.providerReferenceId, revoked: null },
        }),
      ).toBe(0);
    }
  });

  it("blocks refresh and exchange after resource deletion", async () => {
    const session = await issueRealSession();
    const resource = await db.downstreamResource.findUniqueOrThrow({ where: { id: resourceId } });
    await deleteResource(
      { id: resource.id, expectedVersion: resource.version },
      { id: userId, email, requestId: `delete-policy-${runId}` },
    );
    expect((await refreshResponse(session.refresh_token)).status).toBe(400);
    expect((await exchangeResponse(session.refresh_token)).status).toBe(400);
  });
});
