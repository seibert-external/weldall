import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes, LOGIN_SCOPE_KEY } from "@weldall/db";
import {
  createDpopProof,
  generateEs256KeyPair,
  WeldallAuthError,
  type DpopKeyPair,
} from "@weldall/sdk";
import { SignJWT, importJWK } from "jose";
import { createResource, deleteResource, updateResource } from "../src/server/admin/service.js";
import { withRequestLogging } from "../src/server/observability/http.js";
import { logger } from "../src/server/observability/logger.js";
import {
  auditBrowserConnectionFailure,
  browserPendingQuotaExceeded,
  cleanupBrowserConnectionState,
  decidePendingBrowserConnection,
  lookupPendingBrowserConnection,
  normalizeBrowserUserCode,
  parsePendingRequestBody,
  pollBrowserConnectionRequest,
  startBrowserDeviceAuthorization,
} from "../src/server/oauth/browser-connections.js";
import { withBrowserCors } from "../src/server/oauth/browser-cors.js";
import {
  browserClientIdForResourceKey,
  browserOriginsForResource,
  revokeResourceBrowserState,
} from "../src/server/oauth/browser-resources.js";
import {
  WELDALL_ISSUER,
  WELDALL_RESOURCE,
  WELDALL_TOKEN_ENDPOINT,
} from "../src/server/oauth/constants.js";

const runId = randomUUID().replaceAll("-", "");
const key = `browser-${runId}`;
const origin = `https://${key}.example`;
const movedOrigin = `https://${key}-moved.example`;
const resourceIdentifier = `${origin}/resource`;
const email = `${runId}@example.com`;
const userId = `browser-user-${runId}`;
const actor = { id: userId, email, requestId: `browser-${runId}` };
const clientId = browserClientIdForResourceKey(key);
const deviceEndpoint = `${WELDALL_ISSUER}/api/auth/oauth2/device_authorization`;
const proxySecret = "browser-test-proxy-attestation-secret-v1";
let browserKey: DpopKeyPair;
let issuerKey: DpopKeyPair;
let resource: Awaited<ReturnType<typeof createResource>>;
let loginAssignmentId: string;
let loginScopeId: string;

async function start(headers: Record<string, string> = {}) {
  const proof = await createDpopProof({
    ...browserKey,
    method: "POST",
    url: deviceEndpoint,
  });
  return startBrowserDeviceAuthorization(
    new Request(deviceEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        dpop: proof,
        "x-forwarded-for": `start-${randomUUID()}`,
        "x-weldall-proxy-attestation": proxySecret,
        "x-request-id": `start-${randomUUID()}`,
        ...headers,
      },
      body: new URLSearchParams({ client_id: clientId, resource: resourceIdentifier }),
    }),
  );
}

async function poll(
  deviceCode: string,
  options: {
    key?: DpopKeyPair;
    clientId?: string;
    origin?: string;
    now?: Date;
    proof?: string;
    source?: string;
    loginPolicy?: (userId: string) => Promise<boolean>;
  } = {},
) {
  const keyPair = options.key ?? browserKey;
  const proof =
    options.proof ??
    (await createDpopProof({ ...keyPair, method: "POST", url: WELDALL_TOKEN_ENDPOINT }));
  const request = new Request(WELDALL_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      origin: options.origin ?? origin,
      dpop: proof,
      "x-forwarded-for": options.source ?? `poll-${randomUUID()}`,
      "x-weldall-proxy-attestation": proxySecret,
    },
  });
  return pollBrowserConnectionRequest(
    {
      request,
      deviceCode,
      browserClientId: options.clientId ?? clientId,
      ...(options.now ? { now: options.now } : {}),
    },
    options.loginPolicy ? { loginPolicy: options.loginPolicy } : {},
  );
}

beforeAll(async () => {
  browserKey = await generateEs256KeyPair();
  issuerKey = await generateEs256KeyPair();
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: "browser-connections-test-secret-at-least-32-characters",
    WELDALL_TRUSTED_PROXY_SECRET: proxySecret,
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
    WELDALL_SIGNING_KID: `browser-${runId}`,
  });
  await ensureSystemScopes(db, userId);
  await db.user.create({
    data: { id: userId, name: "Browser Test", email, emailVerified: true },
  });
  const loginScope = await db.scope.findUniqueOrThrow({ where: { key: LOGIN_SCOPE_KEY } });
  loginScopeId = loginScope.id;
  const assignment = await db.emailScopeAssignment.create({
    data: {
      normalizedEmail: email,
      createdBy: userId,
      updatedBy: userId,
      grants: { create: { scopeId: loginScope.id, createdBy: userId } },
    },
  });
  loginAssignmentId = assignment.id;
  resource = await createResource(
    {
      key,
      name: "Browser test resource",
      resourceIdentifier,
      authorizationServer: origin,
      downstreamClientId: `downstream-${runId}`,
      enabled: true,
      skillDiscoveryEnabled: false,
      scopeIds: [],
      requestPrefixes: [`${origin}/api`],
    },
    actor,
  );
});

afterAll(async () => {
  await db.oAuthDeviceRefreshBinding.deleteMany({ where: { clientId } });
  await db.browserConnectionRequest.deleteMany({ where: { browserClientId: clientId } });
  await db.browserConnection.deleteMany({ where: { browserClientId: clientId } });
  const current = await db.downstreamResource.findUnique({ where: { key } });
  if (current) await db.downstreamResource.delete({ where: { id: current.id } });
  await db.oauthClient.deleteMany({ where: { clientId } });
  await db.auditEvent.deleteMany({
    where: {
      OR: [{ actorId: userId }, { clientId }, { requestId: { contains: runId } }],
    },
  });
  await db.emailScopeAssignment.deleteMany({ where: { id: loginAssignmentId } });
  await db.user.deleteMany({ where: { id: userId } });
});

describe("browser resource and origin lifecycle", () => {
  it("provisions an exact resource-derived public client", async () => {
    const oauthClient = await db.oauthClient.findUniqueOrThrow({ where: { clientId } });
    expect(oauthClient).toMatchObject({
      id: clientId,
      disabled: false,
      skipConsent: true,
      tokenEndpointAuthMethod: "none",
      dpopBoundAccessTokens: true,
      referenceId: resource.id,
    });
    expect(oauthClient.scopes).not.toContain("expenses:read");
    expect(oauthClient.grantTypes).toContain("urn:ietf:params:oauth:grant-type:device_code");
    expect(
      browserOriginsForResource({
        id: resource.id,
        key,
        name: resource.name,
        resourceIdentifier,
        authorizationServer: origin,
        enabled: true,
        requestPrefixes: [{ urlPrefix: `${origin}/api` }],
      }),
    ).toEqual([origin]);
  });

  it("rejects an unrelated pre-existing client collision even without a reference", async () => {
    const collisionKey = `collision-${runId}`;
    const collisionClientId = browserClientIdForResourceKey(collisionKey);
    await db.oauthClient.create({
      data: {
        id: collisionClientId,
        clientId: collisionClientId,
        disabled: false,
        scopes: [],
        redirectUris: [],
        grantTypes: [],
        responseTypes: [],
      },
    });
    await expect(
      createResource(
        {
          key: collisionKey,
          name: "Collision",
          resourceIdentifier: `https://${collisionKey}.example/api`,
          authorizationServer: `https://${collisionKey}.example`,
          downstreamClientId: `downstream-${collisionKey}`,
          enabled: true,
          skillDiscoveryEnabled: false,
          scopeIds: [],
          requestPrefixes: [`https://${collisionKey}.example/api`],
        },
        actor,
      ),
    ).rejects.toThrow(`Browser client ${collisionClientId} is already bound to another resource`);
    await expect(
      db.downstreamResource.findUnique({ where: { key: collisionKey } }),
    ).resolves.toBeNull();
    await db.oauthClient.delete({ where: { clientId: collisionClientId } });
  });
});

describe("RFC 8628 pending flow", () => {
  it("creates separately hashed five-minute codes bound to origin/resource/JKT and audits safely", async () => {
    const response = await start();
    expect(response).toMatchObject({
      user_code: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
      device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expires_in: 300,
      interval: 5,
    });
    expect(response.device_code).not.toBe(response.user_code);

    const pending = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId },
      orderBy: { createdAt: "desc" },
    });
    expect(pending).toMatchObject({
      origin,
      resourceId: resource.id,
      dpopJkt: browserKey.jkt,
      status: "PENDING",
    });
    expect(pending.deviceCodeHash).not.toContain(response.device_code);
    expect(pending.userCodeHash).not.toContain(response.user_code.replaceAll("-", ""));
    expect(
      Math.abs(pending.expiresAt.getTime() - pending.createdAt.getTime() - 300_000),
    ).toBeLessThan(2_000);

    const audit = await db.auditEvent.findFirstOrThrow({
      where: { eventType: "browser_connection.requested", subjectId: pending.id },
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(response.device_code);
    expect(serialized).not.toContain(response.user_code);
    expect(serialized).toContain(browserKey.jkt);
  });

  it("rejects duplicate, oversized, unregistered-origin, wrong-key and replayed starts without pending rows", async () => {
    const before = await db.browserConnectionRequest.count({
      where: { browserClientId: clientId },
    });
    const duplicate = new Request(deviceEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        "x-forwarded-for": `duplicate-${runId}`,
      },
      body: `client_id=${encodeURIComponent(clientId)}&client_id=${encodeURIComponent(clientId)}&resource=${encodeURIComponent(resourceIdentifier)}`,
    });
    await expect(startBrowserDeviceAuthorization(duplicate)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      parsePendingRequestBody(
        new Request(`${WELDALL_ISSUER}/pending`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "3000",
            "x-forwarded-for": `oversized-lookup-${runId}`,
          },
          body: "{}",
        }),
        false,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      startBrowserDeviceAuthorization(
        new Request(deviceEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin,
            dpop: "not-a-proof",
            "x-forwarded-for": `oversized-${runId}`,
          },
          body: "x".repeat(8_193),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      startBrowserDeviceAuthorization(
        new Request(deviceEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin,
            dpop: "not-a-proof",
            "x-forwarded-for": `invalid-proof-${runId}`,
          },
          body: new URLSearchParams({ client_id: clientId, resource: resourceIdentifier }),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_dpop_proof" });

    const proof = await createDpopProof({ ...browserKey, method: "POST", url: deviceEndpoint });
    await expect(
      startBrowserDeviceAuthorization(
        new Request(deviceEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://attacker.example",
            dpop: proof,
            "x-forwarded-for": `wrong-origin-${runId}`,
          },
          body: new URLSearchParams({ client_id: clientId, resource: resourceIdentifier }),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_client" });

    const otherKey = `other-origin-${runId}`;
    const otherOrigin = `https://${otherKey}.example`;
    const otherResource = await createResource(
      {
        key: otherKey,
        name: "Other origin",
        resourceIdentifier: `${otherOrigin}/api`,
        authorizationServer: otherOrigin,
        downstreamClientId: `downstream-${otherKey}`,
        enabled: true,
        skillDiscoveryEnabled: false,
        scopeIds: [],
        requestPrefixes: [`${otherOrigin}/api`],
      },
      actor,
    );
    const mismatchedProof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: deviceEndpoint,
    });
    await expect(
      startBrowserDeviceAuthorization(
        new Request(deviceEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: otherOrigin,
            dpop: mismatchedProof,
            "x-forwarded-for": `mismatched-origin-${runId}`,
          },
          body: new URLSearchParams({ client_id: clientId, resource: resourceIdentifier }),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_client" });
    await deleteResource({ id: otherResource.id, expectedVersion: otherResource.version }, actor);

    const replayProof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: deviceEndpoint,
    });
    const request = () =>
      new Request(deviceEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          dpop: replayProof,
          "x-forwarded-for": "203.0.113.45",
        },
        body: new URLSearchParams({ client_id: clientId, resource: resourceIdentifier }),
      });
    await startBrowserDeviceAuthorization(request());
    await expect(startBrowserDeviceAuthorization(request())).rejects.toMatchObject({
      code: "invalid_dpop_proof",
    });
    expect(await db.browserConnectionRequest.count({ where: { browserClientId: clientId } })).toBe(
      before + 1,
    );
  });

  it("normalizes lookup codes, enforces live login, records one atomic decision, and uses RFC polling errors/backoff", async () => {
    const response = await start();
    const normalized = normalizeBrowserUserCode(
      `${response.user_code.slice(0, 4).toLowerCase()} ${response.user_code.slice(5).toLowerCase()}`,
    );
    const request = new Request(`${WELDALL_ISSUER}/lookup`, {
      method: "POST",
      headers: { "x-real-ip": "192.0.2.55", "x-request-id": `lookup-${runId}` },
    });
    await expect(
      lookupPendingBrowserConnection(request, { id: userId, email }, normalized),
    ).resolves.toMatchObject({
      userCode: response.user_code,
      origin,
      browserClientId: clientId,
      resource: { id: resource.id, identifier: resourceIdentifier },
      account: { id: userId, email },
    });

    const firstPoll = new Date();
    await expect(
      poll(response.device_code, { key: issuerKey, now: firstPoll }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(poll(response.device_code, { now: firstPoll })).rejects.toMatchObject({
      code: "authorization_pending",
    });
    await expect(poll(response.device_code, { now: firstPoll })).rejects.toMatchObject({
      code: "slow_down",
    });
    const afterSlowDown = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId, deviceCodeHash: { not: "" } },
      orderBy: { createdAt: "desc" },
    });
    expect(afterSlowDown.pollIntervalSeconds).toBe(10);
    expect(afterSlowDown.attempts).toBe(2);

    await db.emailScopeGrant.deleteMany({
      where: { assignmentId: loginAssignmentId, scopeId: loginScopeId },
    });
    await expect(
      decidePendingBrowserConnection(request, { id: userId, email }, normalized, true),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
    await db.emailScopeGrant.create({
      data: { assignmentId: loginAssignmentId, scopeId: loginScopeId, createdBy: userId },
    });

    const decisions = await Promise.allSettled([
      decidePendingBrowserConnection(request, { id: userId, email }, normalized, true),
      decidePendingBrowserConnection(request, { id: userId, email }, normalized, true),
    ]);
    expect(decisions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const saved = await db.browserConnectionRequest.findUniqueOrThrow({
      where: { userCodeHash: afterSlowDown.userCodeHash },
    });
    expect(saved.status).toBe("APPROVED");
    await db.emailScopeGrant.deleteMany({
      where: { assignmentId: loginAssignmentId, scopeId: loginScopeId },
    });
    await expect(
      poll(response.device_code, { now: new Date(firstPoll.getTime() + 20_000) }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      db.browserConnectionRequest.findUniqueOrThrow({
        where: { id: saved.id },
        include: { issuanceAttempt: true },
      }),
    ).resolves.toMatchObject({
      status: "DENIED",
      issuanceAttempt: expect.objectContaining({
        status: "FAILED",
        failureCode: "login_access_removed",
      }),
    });
    await db.emailScopeGrant.create({
      data: { assignmentId: loginAssignmentId, scopeId: loginScopeId, createdBy: userId },
    });
    await expect(
      lookupPendingBrowserConnection(request, { id: userId, email }, normalized),
    ).rejects.toMatchObject({ code: "invalid_grant", message: "connection code is unavailable" });
  });

  it("returns enumeration-resistant lookup errors and the RFC denial poll error", async () => {
    expect(() => normalizeBrowserUserCode("O0I1-ABCD")).toThrow(WeldallAuthError);
    const request = new Request(`${WELDALL_ISSUER}/lookup`, {
      method: "POST",
      headers: { "x-real-ip": "192.0.2.77", "x-request-id": `deny-${runId}` },
    });
    await expect(
      lookupPendingBrowserConnection(request, { id: userId, email }, "2345-6789"),
    ).rejects.toMatchObject({ code: "invalid_grant", message: "connection code is unavailable" });

    const denied = await start();
    await decidePendingBrowserConnection(request, { id: userId, email }, denied.user_code, false);
    await expect(poll(denied.device_code)).rejects.toMatchObject({ code: "access_denied" });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { eventType: "browser_connection.denied", requestId: `deny-${runId}` },
    });
    expect(JSON.stringify(audit)).not.toContain(denied.device_code);
    expect(JSON.stringify(audit)).not.toContain(denied.user_code);
  });

  it("uses indistinguishable invalid-grant polling for unknown and consumed secrets, and expired-token for expiry", async () => {
    await expect(poll(randomUUID())).rejects.toMatchObject({ code: "invalid_grant" });

    const expired = await start();
    const expiredRow = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId },
      orderBy: { createdAt: "desc" },
    });
    await db.browserConnectionRequest.update({
      where: { id: expiredRow.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(poll(expired.device_code)).rejects.toMatchObject({ code: "expired_token" });
    await expect(
      db.browserConnectionRequest.findUniqueOrThrow({ where: { id: expiredRow.id } }),
    ).resolves.toMatchObject({ status: "EXPIRED" });

    const consumed = await start();
    const consumedRow = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId },
      orderBy: { createdAt: "desc" },
    });
    const connection = await db.browserConnection.create({
      data: {
        providerReferenceId: `consumed-reference-${runId}`,
        browserClientId: clientId,
        oauthClientId: clientId,
        resourceId: resource.id,
        resourceKey: key,
        resourceIdentifier,
        origin,
        userId,
        userReferenceId: userId,
        dpopJkt: browserKey.jkt,
        refreshFamilyId: `consumed-${runId}`,
        approvedVia: "cli-code",
      },
    });
    await db.browserConnectionRequest.update({
      where: { id: consumedRow.id },
      data: { status: "CONSUMED", consumedAt: new Date(), connectionId: connection.id },
    });
    await expect(poll(consumed.device_code)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("allows exactly one approved poll to claim the unique issuance journal", async () => {
    const response = await start();
    const decisionRequest = new Request(`${WELDALL_ISSUER}/decision`, {
      method: "POST",
      headers: { "x-forwarded-for": `claim-${runId}` },
    });
    await decidePendingBrowserConnection(
      decisionRequest,
      { id: userId, email },
      response.user_code,
      true,
    );
    const now = new Date(Date.now() + 6_000);
    const results = await Promise.allSettled([
      poll(response.device_code, { now }),
      poll(response.device_code, { now }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const pending = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId },
      orderBy: { createdAt: "desc" },
    });
    expect(pending).toMatchObject({ status: "ISSUING", issuanceClaimedAt: expect.any(Date) });
    await expect(
      db.browserConnectionIssuanceAttempt.findUniqueOrThrow({
        where: { requestId: pending.id },
      }),
    ).resolves.toMatchObject({
      status: "CLAIMED",
      refreshFamilyId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("rejects a claim cancelled while live login policy is resolving", async () => {
    const response = await start();
    await decidePendingBrowserConnection(
      new Request(`${WELDALL_ISSUER}/decision`),
      { id: userId, email },
      response.user_code,
      true,
    );
    let policyStarted!: () => void;
    let releasePolicy!: () => void;
    const started = new Promise<void>((resolve) => (policyStarted = resolve));
    const release = new Promise<void>((resolve) => (releasePolicy = resolve));
    const polling = poll(response.device_code, {
      now: new Date(Date.now() + 6_000),
      loginPolicy: async () => {
        policyStarted();
        await release;
        return true;
      },
    });
    await started;
    const claimed = await db.browserConnectionRequest.findFirstOrThrow({
      where: { browserClientId: clientId, status: "ISSUING" },
      orderBy: { createdAt: "desc" },
    });
    await db.$transaction((tx) =>
      revokeResourceBrowserState(tx, resource, {
        actorId: userId,
        actorType: "user",
        actorEmail: email,
        requestId: `policy-race-${runId}`,
        reason: "connection_revoked_during_policy",
      }),
    );
    releasePolicy();
    await expect(polling).rejects.toMatchObject({
      code: "invalid_grant",
      message: "connection claim is no longer available",
    });
    await expect(
      db.browserConnectionRequest.findUniqueOrThrow({
        where: { id: claimed.id },
        include: { issuanceAttempt: true },
      }),
    ).resolves.toMatchObject({
      status: "DENIED",
      issuanceAttempt: expect.objectContaining({
        status: "FAILED",
        failureCode: "connection_revoked_during_policy",
      }),
    });
  });

  it("verifies and consumes each poll proof with PostgreSQL replay protection", async () => {
    const response = await start();
    const proof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    await expect(poll(response.device_code, { proof })).rejects.toMatchObject({
      code: "authorization_pending",
    });
    await expect(poll(response.device_code, { proof })).rejects.toMatchObject({
      code: "invalid_dpop_proof",
    });
  });

  it("puts forged source and attestation headers in one fail-closed entrance bucket", async () => {
    await db.browserConnectionRateLimitBucket.deleteMany();
    const before = await db.browserConnectionRequest.count({
      where: { browserClientId: clientId },
    });
    const malformed = (spoof: string) =>
      new Request(deviceEndpoint, {
        method: "POST",
        headers: {
          "x-forwarded-for": spoof,
          "x-real-ip": spoof,
          "x-weldall-proxy-attestation": `forged-${spoof}`,
        },
      });
    for (let index = 0; index < 20; index += 1)
      await expect(
        startBrowserDeviceAuthorization(malformed(`203.0.113.${index}`)),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
    await expect(startBrowserDeviceAuthorization(malformed("198.51.100.1"))).rejects.toMatchObject({
      code: "slow_down",
      status: 429,
    });
    expect(await db.browserConnectionRequest.count({ where: { browserClientId: clientId } })).toBe(
      before,
    );
  });

  it("rate-limits malformed lookup and decision bodies before parsing with untrusted sources", async () => {
    for (const decision of [false, true]) {
      await db.browserConnectionRateLimitBucket.deleteMany();
      const malformed = (spoof: string) =>
        new Request(`${WELDALL_ISSUER}/api/me/browser-connections/pending`, {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "x-forwarded-for": spoof,
            "x-real-ip": spoof,
            "x-weldall-proxy-attestation": `forged-${spoof}`,
          },
          body: "not-json",
        });
      for (let index = 0; index < 60; index += 1)
        await expect(
          parsePendingRequestBody(malformed(`203.0.113.${index}`), decision),
        ).rejects.toMatchObject({
          code: "invalid_request",
        });
      await expect(
        parsePendingRequestBody(malformed("198.51.100.1"), decision),
      ).rejects.toMatchObject({
        code: "slow_down",
        status: 429,
      });
    }
  });

  it("enforces every pending quota threshold and bounded terminal cleanup", async () => {
    expect(browserPendingQuotaExceeded({ global: 10_000, resource: 0, origin: 0, client: 0 })).toBe(
      true,
    );
    expect(browserPendingQuotaExceeded({ global: 0, resource: 1_000, origin: 0, client: 0 })).toBe(
      true,
    );
    expect(browserPendingQuotaExceeded({ global: 0, resource: 0, origin: 1_000, client: 0 })).toBe(
      true,
    );
    expect(browserPendingQuotaExceeded({ global: 0, resource: 0, origin: 0, client: 1_000 })).toBe(
      true,
    );
    expect(
      browserPendingQuotaExceeded({ global: 9_999, resource: 999, origin: 999, client: 999 }),
    ).toBe(false);

    const old = new Date(Date.now() - 2 * 86_400_000);
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `cleanup-${runId}-${index}`,
      deviceCodeHash: createHash("sha256")
        .update(`cleanup-device-${runId}-${index}`)
        .digest("base64url"),
      userCodeHash: createHash("sha256")
        .update(`cleanup-user-${runId}-${index}`)
        .digest("base64url"),
      browserClientId: clientId,
      oauthClientId: clientId,
      resourceId: resource.id,
      origin,
      dpopJkt: browserKey.jkt,
      status: "DENIED" as const,
      deniedAt: old,
      expiresAt: old,
      createdAt: old,
      updatedAt: old,
    }));
    await db.browserConnectionRequest.createMany({ data: rows });
    await cleanupBrowserConnectionState(new Date());
    expect(
      await db.browserConnectionRequest.count({ where: { id: { in: rows.map(({ id }) => id) } } }),
    ).toBe(1);
    await db.browserConnectionRequest.deleteMany({
      where: { id: { in: rows.map(({ id }) => id) } },
    });
  });

  it("keeps real browser-route logs and bounded failure audit free of credentials", async () => {
    const secretCode = "ABCD-EFGH";
    const secretDevice = "device-secret-value";
    const secretAuthorization = "DPoP access-token-secret";
    const secretProof = "complete-proof-secret";
    const records: unknown[] = [];
    const detach = logger.attachTransport((record) => records.push(record));
    try {
      const loggedStart = withRequestLogging(
        "/api/auth/oauth2/device_authorization",
        async (request) => {
          try {
            return Response.json(await startBrowserDeviceAuthorization(request));
          } catch (error) {
            await auditBrowserConnectionFailure(request, "start", error);
            return Response.json({ error: "invalid_request" }, { status: 400 });
          }
        },
      );
      const response = await loggedStart(
        new Request(deviceEndpoint, {
          method: "POST",
          headers: {
            origin,
            authorization: secretAuthorization,
            dpop: secretProof,
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": `route-log-${runId}`,
            "x-weldall-proxy-attestation": proxySecret,
            "x-request-id": `route-log-${runId}`,
          },
          body: new URLSearchParams({
            client_id: clientId,
            resource: resourceIdentifier,
            device_code: secretDevice,
            user_code: secretCode,
          }),
        }),
      );
      expect(response.status).toBe(400);
    } finally {
      detach();
    }
    const logText = JSON.stringify(records);
    for (const secret of [secretCode, secretDevice, secretAuthorization, secretProof, proxySecret])
      expect(logText).not.toContain(secret);

    for (let index = 0; index < 11; index += 1) {
      await auditBrowserConnectionFailure(
        new Request(`${WELDALL_ISSUER}/api/auth/oauth2/device_authorization`, {
          method: "POST",
          headers: {
            authorization: secretAuthorization,
            dpop: secretProof,
            "x-forwarded-for": `audit-source-${runId}`,
            "x-weldall-proxy-attestation": proxySecret,
            "x-request-id": `failure-audit-${runId}`,
          },
          body: JSON.stringify({ userCode: secretCode, deviceCode: secretDevice }),
        }),
        "start",
        new WeldallAuthError("invalid_request"),
      );
    }
    const events = await db.auditEvent.findMany({
      where: {
        eventType: "browser_connection.failed",
        requestId: `failure-audit-${runId}`,
      },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(10);
    const serialized = JSON.stringify(events);
    for (const secret of [secretCode, secretDevice, secretAuthorization, secretProof, proxySecret])
      expect(serialized).not.toContain(secret);
  });

  it("enforces the durable per-network start limit before allocating another pending row", async () => {
    const source = `rate-source-${runId}`;
    const before = await db.browserConnectionRequest.count({
      where: { browserClientId: clientId },
    });
    for (let index = 0; index < 20; index += 1) {
      await start({ "x-forwarded-for": source });
    }
    await expect(start({ "x-forwarded-for": source })).rejects.toMatchObject({
      code: "slow_down",
      status: 429,
    });
    expect(await db.browserConnectionRequest.count({ where: { browserClientId: clientId } })).toBe(
      before + 20,
    );
  });
});

describe("browser CORS", () => {
  it("answers exact preflight before the protected handler and decorates OAuth errors", async () => {
    const protectedHandler = vi.fn(() =>
      Response.json(
        { error: "invalid_grant" },
        { status: 400, headers: { "www-authenticate": "DPoP" } },
      ),
    );
    const entrance = vi.fn();
    const rejectedActual = vi.fn();
    const handler = withBrowserCors(["POST"], protectedHandler, {
      beforeActual: entrance,
      onRejectedActualOrigin: rejectedActual,
    });
    const preflight = await handler(
      new Request(`${WELDALL_ISSUER}/api/auth/oauth2/token`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "Authorization, DPoP, Content-Type",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(protectedHandler).not.toHaveBeenCalled();
    expect(entrance).not.toHaveBeenCalled();
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, DPoP, X-Correlation-Id, X-Request-Id",
    );
    expect(preflight.headers.get("access-control-expose-headers")).toBe(
      "WWW-Authenticate, DPoP-Nonce, X-Request-Id",
    );
    expect(new Set(preflight.headers.get("vary")?.split(", "))).toEqual(
      new Set(["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]),
    );

    const actual = await handler(
      new Request(`${WELDALL_ISSUER}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { origin },
      }),
    );
    expect(actual.status).toBe(400);
    expect(entrance).toHaveBeenCalledOnce();
    expect(actual.headers.get("access-control-allow-origin")).toBe(origin);
    expect(actual.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");

    const successHandler = withBrowserCors(["POST"], () => Response.json({ ok: true }));
    const success = await successHandler(
      new Request(`${WELDALL_ISSUER}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { origin },
      }),
    );
    expect(success.status).toBe(200);
    expect(success.headers.get("access-control-allow-origin")).toBe(origin);

    for (const rejectedOrigin of [
      null,
      "*",
      "null",
      "http://insecure.example",
      "https://not-registered.example",
    ]) {
      const headers = new Headers({ "access-control-request-method": "POST" });
      if (rejectedOrigin !== null) headers.set("origin", rejectedOrigin);
      const rejected = await handler(
        new Request(`${WELDALL_ISSUER}/api/auth/oauth2/token`, {
          method: "OPTIONS",
          headers,
        }),
      );
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
      expect(rejected.headers.get("vary")).toContain("Access-Control-Request-Headers");
    }
    for (const headers of [
      { origin, "access-control-request-method": "DELETE" },
      {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "Cookie",
      },
    ]) {
      const rejected = await handler(
        new Request(`${WELDALL_ISSUER}/api/auth/oauth2/token`, {
          method: "OPTIONS",
          headers,
        }),
      );
      expect(rejected.status).toBe(403);
    }

    const malformedActual = await handler(
      new Request(`${WELDALL_ISSUER}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { origin: "*" },
      }),
    );
    expect(malformedActual.status).toBe(403);
    expect(rejectedActual).toHaveBeenCalledOnce();

    const originless = await successHandler(
      new Request(`${WELDALL_ISSUER}/api/auth/oauth2/token`, { method: "POST" }),
    );
    expect(originless.status).toBe(200);
    expect(originless.headers.get("access-control-allow-origin")).toBeNull();
    expect(protectedHandler).toHaveBeenCalledOnce();
  });
});

describe("resource mutation revocation", () => {
  it("revokes connections/families on origin removal and retains the audit snapshot on delete", async () => {
    const connection = await db.browserConnection.create({
      data: {
        providerReferenceId: `lifecycle-reference-${runId}`,
        browserClientId: clientId,
        oauthClientId: clientId,
        resourceId: resource.id,
        resourceKey: key,
        resourceIdentifier,
        origin,
        userId,
        userReferenceId: userId,
        dpopJkt: browserKey.jkt,
        refreshFamilyId: `family-${runId}`,
        approvedVia: "cli-code",
      },
    });
    const tokenHash = createHash("sha256").update(`refresh-${runId}`).digest("base64url");
    await db.oAuthDeviceRefreshBinding.create({
      data: {
        tokenHash,
        familyId: connection.refreshFamilyId,
        clientId,
        userId,
        dpopJkt: browserKey.jkt,
        browserConnectionId: connection.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      db.oAuthDeviceRefreshBinding.create({
        data: {
          tokenHash: createHash("sha256").update(`mismatch-${runId}`).digest("base64url"),
          familyId: `wrong-family-${runId}`,
          clientId,
          userId,
          dpopJkt: browserKey.jkt,
          browserConnectionId: connection.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();

    const disposableConnection = await db.browserConnection.create({
      data: {
        providerReferenceId: `cascade-reference-${runId}`,
        browserClientId: clientId,
        oauthClientId: clientId,
        resourceId: resource.id,
        resourceKey: key,
        resourceIdentifier,
        origin,
        userId,
        userReferenceId: userId,
        dpopJkt: browserKey.jkt,
        refreshFamilyId: `cascade-family-${runId}`,
        approvedVia: "cli-code",
      },
    });
    const disposableHash = createHash("sha256")
      .update(`cascade-refresh-${runId}`)
      .digest("base64url");
    await db.oAuthDeviceRefreshBinding.create({
      data: {
        tokenHash: disposableHash,
        familyId: disposableConnection.refreshFamilyId,
        clientId,
        userId,
        dpopJkt: browserKey.jkt,
        browserConnectionId: disposableConnection.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await db.browserConnection.delete({ where: { id: disposableConnection.id } });
    await expect(
      db.oAuthDeviceRefreshBinding.findUnique({ where: { tokenHash: disposableHash } }),
    ).resolves.toBeNull();

    const issuance = await start();
    await decidePendingBrowserConnection(
      new Request(`${WELDALL_ISSUER}/decision`),
      { id: userId, email },
      issuance.user_code,
      true,
    );
    await poll(issuance.device_code, { now: new Date(Date.now() + 6_000) });
    const issuingBeforeMutation = await db.browserConnectionRequest.findMany({
      where: { resourceId: resource.id, status: "ISSUING" },
      select: { id: true },
    });
    expect(issuingBeforeMutation.length).toBeGreaterThan(0);
    await db.oauthClient.update({
      where: { clientId },
      data: {
        redirectUris: ["https://attacker.example/callback"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "client_secret_post",
        requirePKCE: true,
        dpopBoundAccessTokens: false,
      },
    });

    resource = await updateResource(
      {
        id: resource.id,
        name: resource.name,
        authorizationServer: movedOrigin,
        downstreamClientId: resource.downstreamClientId,
        enabled: true,
        skillDiscoveryEnabled: false,
        scopeIds: resource.scopeIds,
        requestPrefixes: [`${movedOrigin}/api`],
        expectedVersion: resource.version,
      },
      actor,
    );
    await expect(
      db.browserConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({
      state: "REVOKED",
      revocationReason: "origin_removed",
    });
    await expect(
      db.oAuthDeviceRefreshBinding.findUniqueOrThrow({ where: { tokenHash } }),
    ).resolves.toEqual(expect.objectContaining({ revokedAt: expect.any(Date) }));
    const revocationAudit = await db.auditEvent.findFirstOrThrow({
      where: { eventType: "browser_connection.revoked", subjectId: connection.id },
    });
    expect(revocationAudit.metadata).toEqual(
      expect.objectContaining({ connectionId: connection.id, revocationReason: "origin_removed" }),
    );
    expect(JSON.stringify(revocationAudit)).not.toContain(`refresh-${runId}`);
    const oauthClient = await db.oauthClient.findUniqueOrThrow({ where: { clientId } });
    expect(oauthClient).toMatchObject({
      redirectUris: [],
      responseTypes: [],
      tokenEndpointAuthMethod: "none",
      requirePKCE: false,
      dpopBoundAccessTokens: true,
    });
    expect(JSON.stringify(oauthClient.metadata)).toContain(movedOrigin);
    expect(JSON.stringify(oauthClient.metadata)).not.toContain(`\"${origin}\"`);
    const cancelled = await db.browserConnectionRequest.findMany({
      where: { id: { in: issuingBeforeMutation.map(({ id }) => id) } },
      include: { issuanceAttempt: true },
    });
    expect(cancelled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "DENIED",
          issuanceAttempt: expect.objectContaining({
            status: "FAILED",
            failureCode: "origin_removed",
          }),
        }),
      ]),
    );
    await expect(
      db.auditEvent.count({
        where: {
          eventType: "browser_connection.failed",
          subjectId: { in: issuingBeforeMutation.map(({ id }) => id) },
        },
      }),
    ).resolves.toBeGreaterThan(0);

    const oldOriginCors = withBrowserCors(["POST"], () => new Response(null));
    const rejected = await oldOriginCors(
      new Request(`${WELDALL_ISSUER}/api/auth/oauth2/token`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" },
      }),
    );
    expect(rejected.status).toBe(403);

    const secondConnection = await db.browserConnection.create({
      data: {
        providerReferenceId: `disabled-reference-${runId}`,
        browserClientId: clientId,
        oauthClientId: clientId,
        resourceId: resource.id,
        resourceKey: key,
        resourceIdentifier,
        origin: movedOrigin,
        userId,
        userReferenceId: userId,
        dpopJkt: browserKey.jkt,
        refreshFamilyId: `disabled-family-${runId}`,
        approvedVia: "cli-code",
      },
    });
    resource = await updateResource(
      {
        id: resource.id,
        name: resource.name,
        authorizationServer: movedOrigin,
        downstreamClientId: resource.downstreamClientId,
        enabled: false,
        skillDiscoveryEnabled: false,
        scopeIds: resource.scopeIds,
        requestPrefixes: [`${movedOrigin}/api`],
        expectedVersion: resource.version,
      },
      actor,
    );
    await expect(
      db.browserConnection.findUniqueOrThrow({ where: { id: secondConnection.id } }),
    ).resolves.toMatchObject({ state: "REVOKED", revocationReason: "resource_disabled" });
    await expect(db.oauthClient.findUniqueOrThrow({ where: { clientId } })).resolves.toMatchObject({
      disabled: true,
    });

    await deleteResource({ id: resource.id, expectedVersion: resource.version }, actor);
    await expect(db.oauthClient.findUnique({ where: { clientId } })).resolves.toBeNull();
    await expect(
      db.browserConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({
      resourceId: null,
      resourceKey: key,
      resourceIdentifier,
      state: "REVOKED",
    });
  });
});

describe("CLI API client separation", () => {
  it("rejects an otherwise valid browser-client access token at CLI approval APIs", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const accessToken = await new SignJWT({
      scope: "weldall:scopes",
      client_id: clientId,
      cnf: { jkt: browserKey.jkt },
    })
      .setProtectedHeader({ alg: "ES256", kid: `browser-${runId}`, typ: "at+jwt" })
      .setIssuer(WELDALL_ISSUER)
      .setAudience(WELDALL_RESOURCE)
      .setSubject(userId)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(await importJWK(issuerKey.privateJwk, "ES256"));
    const endpoint = `${WELDALL_ISSUER}/api/me/browser-connections/pending/lookup`;
    const proof = await createDpopProof({
      ...browserKey,
      method: "POST",
      url: endpoint,
      accessToken,
    });
    const { authenticateCliApiRequest } = await import("../src/server/oauth/cli-api.js");
    await expect(
      authenticateCliApiRequest(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `DPoP ${accessToken}`, dpop: proof },
        }),
        { expectedUrl: endpoint, requiredScope: "weldall:scopes", expectedClientId: "weldall-cli" },
      ),
    ).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
  });
});
