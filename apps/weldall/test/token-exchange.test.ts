import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ID_JAG_TOKEN_TYPE,
  REFRESH_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  createDpopProof,
  generateEs256KeyPair,
  verifyIdJag,
  type DpopKeyPair,
} from "@weldall/sdk";
import {
  WELDALL_CLIENT_ID,
  WELDALL_ISSUER,
  WELDALL_RESOURCE,
  WELDALL_REVOCATION_ENDPOINT,
  WELDALL_TOKEN_ENDPOINT,
} from "../src/server/oauth/constants.js";

const EXPENSES_ISSUER = "https://expenses.seibert.localdev";
const EXPENSES_RESOURCE = `${EXPENSES_ISSUER}/api`;
const DOWNSTREAM_CLIENT_ID = "weldall-cli-at-expenses";

const authHandler = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("Better Auth handler is not used by token-exchange policy tests");
  }),
);

vi.mock("../src/server/auth/auth.js", () => ({ auth: { handler: authHandler } }));

const userId = "weldall-token-exchange-test-user";
const email = "token-exchange-test@example.com";
const refreshToken = "test-refresh-token-never-issued";
const sharedResource = "https://shared-token-exchange.example/api";
const sharedIssuer = "https://shared-token-exchange.example";
const sharedClientId = "weldall-cli-at-shared-test";
const issuedAuditRequestId = `issued-${randomUUID()}`;
let issuerKey: DpopKeyPair;
let deviceKey: DpopKeyPair;

beforeAll(async () => {
  issuerKey = await generateEs256KeyPair();
  deviceKey = await generateEs256KeyPair();
  Object.assign(process.env, {
    POSTGRES_URL: process.env.POSTGRES_URL ?? "postgresql://postgres@localhost:5433/postgres",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
    OAUTH_PROXY_SECRET: "test-oauth-proxy-secret-at-least-32-characters",
    GOOGLE_CLIENT_ID: "google-test-client",
    GOOGLE_CLIENT_SECRET: "google-test-secret",
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
    WELDALL_SIGNING_KID: "weldall-token-exchange-test",
  });
  const { db, ensureSystemScopes, LOGIN_SCOPE_KEY } = await import("@weldall/db");
  await ensureSystemScopes(db, "token-exchange-test");
  await db.user.upsert({
    where: { id: userId },
    update: { email, emailVerified: true },
    create: {
      id: userId,
      name: "Token Exchange Test",
      email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  const assignment = await db.emailScopeAssignment.upsert({
    where: { normalizedEmail: email },
    update: { updatedBy: "token-exchange-test" },
    create: {
      normalizedEmail: email,
      createdBy: "token-exchange-test",
      updatedBy: "token-exchange-test",
    },
  });
  const [readScope, loginScope] = await Promise.all([
    db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } }),
    db.scope.findUniqueOrThrow({ where: { key: LOGIN_SCOPE_KEY } }),
  ]);
  await db.downstreamResource.deleteMany({ where: { key: "token-exchange-shared" } });
  await db.downstreamResource.create({
    data: {
      key: "token-exchange-shared",
      name: "Shared token exchange test",
      resourceIdentifier: sharedResource,
      authorizationServer: sharedIssuer,
      downstreamClientId: sharedClientId,
      createdBy: "token-exchange-test",
      updatedBy: "token-exchange-test",
      scopes: { create: { scopeId: readScope.id } },
      requestPrefixes: {
        create: { urlPrefix: `${sharedIssuer}/api`, createdBy: "token-exchange-test" },
      },
    },
  });
  await db.emailScopeGrant.deleteMany({ where: { assignmentId: assignment.id } });
  await db.emailScopeGrant.createMany({
    data: [readScope, loginScope].map((scope) => ({
      id: randomUUID(),
      assignmentId: assignment.id,
      scopeId: scope.id,
      createdBy: "token-exchange-test",
    })),
  });
  const tokenHash = createHash("sha256").update(refreshToken, "ascii").digest("base64url");
  await db.oauthRefreshToken.upsert({
    where: { token: tokenHash },
    update: {
      userId,
      confirmation: JSON.stringify({ jkt: deviceKey.jkt }),
      expiresAt: new Date(Date.now() + 60_000),
      rotatedAt: null,
      revoked: null,
    },
    create: {
      id: "weldall-token-exchange-provider-refresh",
      token: tokenHash,
      clientId: WELDALL_CLIENT_ID,
      userId,
      confirmation: JSON.stringify({ jkt: deviceKey.jkt }),
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ["openid", "offline_access", "weldall:scopes"],
    },
  });
  await db.oAuthDeviceRefreshBinding.upsert({
    where: { tokenHash },
    update: {
      userId,
      dpopJkt: deviceKey.jkt,
      expiresAt: new Date(Date.now() + 60_000),
      rotatedAt: null,
      revokedAt: null,
    },
    create: {
      tokenHash: createHash("sha256").update(refreshToken, "ascii").digest("base64url"),
      familyId: "weldall-token-exchange-test-family",
      clientId: WELDALL_CLIENT_ID,
      userId,
      dpopJkt: deviceKey.jkt,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
});

afterAll(async () => {
  const { db } = await import("@weldall/db");
  await db.oAuthDeviceRefreshBinding.deleteMany({ where: { userId } });
  await db.oauthRefreshToken.deleteMany({ where: { userId } });
  await db.auditEvent.deleteMany({ where: { actorId: userId } });
  await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: email } });
  await db.downstreamResource.deleteMany({ where: { key: "token-exchange-shared" } });
  await db.user.deleteMany({ where: { id: userId } });
});

describe("Weldall token exchange", () => {
  it("issues a draft-04 ID-JAG bound to the refresh-token device key", async () => {
    const proof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: proof,
          "x-request-id": issuedAuditRequestId,
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          scope: "expenses:read",
          subject_token: refreshToken,
          subject_token_type: REFRESH_TOKEN_TYPE,
          client_id: WELDALL_CLIENT_ID,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access_token: string;
      issued_token_type: string;
      token_type: string;
    };
    expect(body).toMatchObject({
      issued_token_type: ID_JAG_TOKEN_TYPE,
      token_type: "N_A",
    });
    const claims = await verifyIdJag(body.access_token, {
      issuer: WELDALL_ISSUER,
      audience: EXPENSES_ISSUER,
      resource: EXPENSES_RESOURCE,
      clientId: DOWNSTREAM_CLIENT_ID,
      kid: "weldall-token-exchange-test",
      publicJwk: issuerKey.publicJwk,
      allowedScopes: ["expenses:read"],
    });
    expect(claims).toMatchObject({ sub: userId, cnf: { jkt: deviceKey.jkt } });

    const { db } = await import("@weldall/db");
    const auditEvent = await db.auditEvent.findFirstOrThrow({
      where: { requestId: issuedAuditRequestId, eventType: "id_jag.issued" },
    });
    expect(auditEvent.deduplicationKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auditEvent.deduplicationKey).not.toContain(issuedAuditRequestId);
    expect(auditEvent).toMatchObject({
      eventType: "id_jag.issued",
      actorId: userId,
      actorEmail: email,
      clientId: WELDALL_CLIENT_ID,
      outcome: "success",
      subjectId: claims.jti,
      metadata: expect.objectContaining({
        resource: EXPENSES_RESOURCE,
        grantedScopes: ["expenses:read"],
        jti: claims.jti,
        kid: "weldall-token-exchange-test",
      }),
    });
    const serializedAudit = JSON.stringify(auditEvent);
    expect(serializedAudit).not.toContain(body.access_token);
    expect(serializedAudit).not.toContain(proof);
    expect(serializedAudit).not.toContain(refreshToken);
  });

  it("blocks ID-JAG issuance after the server login scope is revoked", async () => {
    const { db, LOGIN_SCOPE_KEY } = await import("@weldall/db");
    const loginScope = await db.scope.findUniqueOrThrow({ where: { key: LOGIN_SCOPE_KEY } });
    const assignment = await db.emailScopeAssignment.findUniqueOrThrow({
      where: { normalizedEmail: email },
    });
    await db.emailScopeGrant.deleteMany({
      where: { assignmentId: assignment.id, scopeId: loginScope.id },
    });
    try {
      const proof = await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      const { tokenFacade } = await import("../src/server/oauth/facade.js");
      const response = await tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: proof,
          },
          body: new URLSearchParams({
            grant_type: TOKEN_EXCHANGE_GRANT,
            requested_token_type: ID_JAG_TOKEN_TYPE,
            audience: EXPENSES_ISSUER,
            resource: EXPENSES_RESOURCE,
            scope: "expenses:read",
            subject_token: refreshToken,
            subject_token_type: REFRESH_TOKEN_TYPE,
            client_id: WELDALL_CLIENT_ID,
          }),
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    } finally {
      await db.emailScopeGrant.create({
        data: {
          id: randomUUID(),
          assignmentId: assignment.id,
          scopeId: loginScope.id,
          createdBy: "token-exchange-test",
        },
      });
    }
  });

  it("returns invalid_grant when a revoked user attempts CLI refresh", async () => {
    const { db, LOGIN_SCOPE_KEY } = await import("@weldall/db");
    const loginScope = await db.scope.findUniqueOrThrow({ where: { key: LOGIN_SCOPE_KEY } });
    const assignment = await db.emailScopeAssignment.findUniqueOrThrow({
      where: { normalizedEmail: email },
    });
    const now = Math.floor(Date.now() / 1_000);
    const { signWeldallJwt } = await import("../src/server/oauth/jwt.js");
    const providerAccessToken = await signWeldallJwt({
      iss: WELDALL_ISSUER,
      sub: userId,
      aud: WELDALL_RESOURCE,
      client_id: WELDALL_CLIENT_ID,
      scope: "openid offline_access weldall:scopes",
      cnf: { jkt: deviceKey.jkt },
      iat: now,
      exp: now + 300,
    });
    await db.emailScopeGrant.deleteMany({
      where: { assignmentId: assignment.id, scopeId: loginScope.id },
    });
    try {
      authHandler.mockResolvedValueOnce(
        Response.json({
          access_token: providerAccessToken,
          refresh_token: "replacement-refresh-token-not-returned",
          token_type: "DPoP",
        }),
      );
      const proof = await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      const { tokenFacade } = await import("../src/server/oauth/facade.js");
      const response = await tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: proof,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: WELDALL_CLIENT_ID,
          }),
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    } finally {
      await db.emailScopeGrant.create({
        data: {
          id: randomUUID(),
          assignmentId: assignment.id,
          scopeId: loginScope.id,
          createdBy: "token-exchange-test",
        },
      });
    }
  });

  it("does not create a second success event when a request ID is retried", async () => {
    const proof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: proof,
          "x-request-id": issuedAuditRequestId,
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          scope: "expenses:read",
          subject_token: refreshToken,
          subject_token_type: REFRESH_TOKEN_TYPE,
          client_id: WELDALL_CLIENT_ID,
        }),
      }),
    );
    expect(response.status).toBe(500);
    const { db } = await import("@weldall/db");
    await expect(
      db.auditEvent.count({
        where: { requestId: issuedAuditRequestId, eventType: "id_jag.issued" },
      }),
    ).resolves.toBe(1);
  });

  it("uses the same global grant for a second registered resource", async () => {
    const proof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: sharedIssuer,
          resource: sharedResource,
          scope: "expenses:read",
          subject_token: refreshToken,
          subject_token_type: REFRESH_TOKEN_TYPE,
          client_id: WELDALL_CLIENT_ID,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string };
    await expect(
      verifyIdJag(body.access_token, {
        issuer: WELDALL_ISSUER,
        audience: sharedIssuer,
        resource: sharedResource,
        clientId: sharedClientId,
        kid: "weldall-token-exchange-test",
        publicJwk: issuerKey.publicJwk,
        allowedScopes: ["expenses:read"],
      }),
    ).resolves.toMatchObject({ sub: userId });
  });

  it("audits a denied scope request with a stable, sanitized reason", async () => {
    const requestId = `denied-${randomUUID()}`;
    const proof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: proof,
          "x-request-id": requestId,
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          scope: "expenses:delete",
          subject_token: refreshToken,
          subject_token_type: REFRESH_TOKEN_TYPE,
          client_id: WELDALL_CLIENT_ID,
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_scope" });

    const { db } = await import("@weldall/db");
    const event = await db.auditEvent.findFirstOrThrow({
      where: { requestId, eventType: "id_jag.denied" },
    });
    expect(event).toMatchObject({
      eventType: "id_jag.denied",
      actorId: userId,
      reasonCode: "scope_not_granted",
      outcome: "denied",
      metadata: {
        audience: EXPENSES_ISSUER,
        resource: EXPENSES_RESOURCE,
        requestedScopes: ["expenses:delete"],
      },
    });
    const serializedAudit = JSON.stringify(event);
    expect(serializedAudit).not.toContain(proof);
    expect(serializedAudit).not.toContain(refreshToken);
  });

  it("audits an invalid ID-JAG DPoP proof without storing the proof", async () => {
    const requestId = `dpop-denied-${randomUUID()}`;
    const attacker = await generateEs256KeyPair();
    const proof = await createDpopProof({
      ...attacker,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: proof,
          "x-request-id": requestId,
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          scope: "expenses:read",
          subject_token: refreshToken,
          subject_token_type: REFRESH_TOKEN_TYPE,
          client_id: WELDALL_CLIENT_ID,
        }),
      }),
    );
    expect(response.status).toBe(400);
    const { db } = await import("@weldall/db");
    const event = await db.auditEvent.findFirstOrThrow({
      where: { requestId, eventType: "id_jag.denied" },
    });
    expect(event).toMatchObject({
      eventType: "id_jag.denied",
      actorId: userId,
      reasonCode: "invalid_dpop_proof",
    });
    expect(JSON.stringify(event)).not.toContain(proof);
  });

  it("records repeated denied attempts even when the caller reuses a request ID", async () => {
    const requestId = `repeated-denial-${randomUUID()}`;
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      const response = await tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: proof,
            "x-request-id": requestId,
          },
          body: new URLSearchParams({
            grant_type: TOKEN_EXCHANGE_GRANT,
            requested_token_type: ID_JAG_TOKEN_TYPE,
            audience: EXPENSES_ISSUER,
            resource: EXPENSES_RESOURCE,
            scope: "expenses:delete",
            subject_token: refreshToken,
            subject_token_type: REFRESH_TOKEN_TYPE,
            client_id: WELDALL_CLIENT_ID,
          }),
        }),
      );
      expect(response.status).toBe(400);
    }

    const { db } = await import("@weldall/db");
    await expect(
      db.auditEvent.count({ where: { requestId, eventType: "id_jag.denied" } }),
    ).resolves.toBe(2);
  });

  it("does not attribute an invalid client ID to the attacker-chosen identity", async () => {
    const requestId = `invalid-client-${randomUUID()}`;
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-request-id": requestId,
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          scope: "expenses:read",
          subject_token: refreshToken,
          subject_token_type: REFRESH_TOKEN_TYPE,
          client_id: "attacker-chosen-client",
        }),
      }),
    );
    expect(response.status).toBe(400);

    const { db } = await import("@weldall/db");
    const event = await db.auditEvent.findFirstOrThrow({
      where: { requestId, eventType: "id_jag.denied" },
    });
    expect(event).toMatchObject({
      actorType: "anonymous",
      actorId: "anonymous",
      clientId: null,
      reasonCode: "invalid_client",
    });
    await db.auditEvent.deleteMany({ where: { requestId } });
  });

  it("classifies a reused DPoP proof with a structured replay reason", async () => {
    const proof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const request = (requestId: string) =>
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: proof,
          "x-request-id": requestId,
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          scope: "expenses:read",
          subject_token: refreshToken,
          subject_token_type: REFRESH_TOKEN_TYPE,
          client_id: WELDALL_CLIENT_ID,
        }),
      });
    expect((await tokenFacade(request(`replay-first-${randomUUID()}`))).status).toBe(200);
    const replayRequestId = `replay-denied-${randomUUID()}`;
    const response = await tokenFacade(request(replayRequestId));
    expect(response.status).toBe(400);

    const { db } = await import("@weldall/db");
    await expect(
      db.auditEvent.findFirstOrThrow({
        where: { requestId: replayRequestId, eventType: "id_jag.denied" },
      }),
    ).resolves.toMatchObject({ reasonCode: "replay_detected" });
  });

  it("fails ID-JAG issuance closed when the audit store cannot write", async () => {
    const proof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const unavailableAuditWriter = {
      write: vi.fn(async () => {
        throw new Error("audit unavailable");
      }),
    };
    const { tokenFacadeWithAuditWriter } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacadeWithAuditWriter(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: proof,
          "x-request-id": `unavailable-${randomUUID()}`,
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          scope: "expenses:read",
          subject_token: refreshToken,
          subject_token_type: REFRESH_TOKEN_TYPE,
          client_id: WELDALL_CLIENT_ID,
        }),
      }),
      unavailableAuditWriter,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "server_error" });
    expect(unavailableAuditWriter.write).toHaveBeenCalled();
  });

  it("rejects a disabled registered resource immediately", async () => {
    const { db } = await import("@weldall/db");
    await db.downstreamResource.update({
      where: { resourceIdentifier: EXPENSES_RESOURCE },
      data: { enabled: false },
    });
    try {
      const proof = await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      const { tokenFacade } = await import("../src/server/oauth/facade.js");
      const response = await tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
          body: new URLSearchParams({
            grant_type: TOKEN_EXCHANGE_GRANT,
            requested_token_type: ID_JAG_TOKEN_TYPE,
            audience: EXPENSES_ISSUER,
            resource: EXPENSES_RESOURCE,
            scope: "expenses:read",
            subject_token: refreshToken,
            subject_token_type: REFRESH_TOKEN_TYPE,
            client_id: WELDALL_CLIENT_ID,
          }),
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_target" });
    } finally {
      await db.downstreamResource.update({
        where: { resourceIdentifier: EXPENSES_RESOURCE },
        data: { enabled: true },
      });
    }
  });

  it("rejects a stolen refresh token presented with another DPoP key", async () => {
    const attacker = await generateEs256KeyPair();
    const proof = await createDpopProof({
      ...attacker,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: proof,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: WELDALL_CLIENT_ID,
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });
    const { db } = await import("@weldall/db");
    await expect(
      db.oAuthDeviceRefreshBinding.findFirstOrThrow({ where: { userId } }),
    ).resolves.toMatchObject({ rotatedAt: null, revokedAt: null });
  });

  it("rejects scope escalation and duplicate exchange parameters", async () => {
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const makeRequest = async (body: URLSearchParams) => {
      const proof = await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      return tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: proof,
          },
          body,
        }),
      );
    };
    const base = () =>
      new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        requested_token_type: ID_JAG_TOKEN_TYPE,
        audience: EXPENSES_ISSUER,
        resource: EXPENSES_RESOURCE,
        scope: "expenses:read expenses:delete",
        subject_token: refreshToken,
        subject_token_type: REFRESH_TOKEN_TYPE,
        client_id: WELDALL_CLIENT_ID,
      });
    const escalation = await makeRequest(base());
    expect(escalation.status).toBe(400);
    await expect(escalation.json()).resolves.toMatchObject({ error: "invalid_scope" });

    const mismatch = base();
    mismatch.set("scope", "expenses:read");
    mismatch.set("audience", sharedIssuer);
    const mismatchResponse = await makeRequest(mismatch);
    expect(mismatchResponse.status).toBe(400);
    await expect(mismatchResponse.json()).resolves.toMatchObject({ error: "invalid_target" });

    const duplicate = base();
    duplicate.set("scope", "expenses:read");
    duplicate.append("audience", "https://attacker.example");
    const duplicateResponse = await makeRequest(duplicate);
    expect(duplicateResponse.status).toBe(400);
    await expect(duplicateResponse.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("revokes a refresh-token family when the provider detects exchange reuse first", async () => {
    const { db } = await import("@weldall/db");
    const familyId = `exchange-reuse-${randomUUID()}`;
    const reusedToken = `reused-${randomUUID()}`;
    const reusedHash = createHash("sha256").update(reusedToken, "ascii").digest("base64url");
    const replacementHash = createHash("sha256")
      .update(`replacement-${randomUUID()}`, "ascii")
      .digest("base64url");
    await db.oauthRefreshToken.create({
      data: {
        id: `provider-${randomUUID()}`,
        token: reusedHash,
        clientId: WELDALL_CLIENT_ID,
        userId,
        confirmation: JSON.stringify({ jkt: deviceKey.jkt }),
        expiresAt: new Date(Date.now() + 60_000),
        rotatedAt: new Date(),
        scopes: ["openid", "offline_access", "weldall:scopes"],
      },
    });
    await db.oAuthDeviceRefreshBinding.createMany({
      data: [
        {
          tokenHash: reusedHash,
          familyId,
          clientId: WELDALL_CLIENT_ID,
          userId,
          dpopJkt: deviceKey.jkt,
          expiresAt: new Date(Date.now() + 60_000),
          replacementHash,
        },
        {
          tokenHash: replacementHash,
          familyId,
          clientId: WELDALL_CLIENT_ID,
          userId,
          dpopJkt: deviceKey.jkt,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });

    try {
      const proof = await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      const { tokenFacade } = await import("../src/server/oauth/facade.js");
      const response = await tokenFacade(
        new Request(WELDALL_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
          body: new URLSearchParams({
            grant_type: TOKEN_EXCHANGE_GRANT,
            requested_token_type: ID_JAG_TOKEN_TYPE,
            audience: EXPENSES_ISSUER,
            resource: EXPENSES_RESOURCE,
            scope: "expenses:read",
            subject_token: reusedToken,
            subject_token_type: REFRESH_TOKEN_TYPE,
            client_id: WELDALL_CLIENT_ID,
          }),
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
      const family = await db.oAuthDeviceRefreshBinding.findMany({ where: { familyId } });
      expect(family).toHaveLength(2);
      expect(family.every(({ revokedAt }) => revokedAt instanceof Date)).toBe(true);
    } finally {
      await db.oAuthDeviceRefreshBinding.deleteMany({ where: { familyId } });
      await db.oauthRefreshToken.deleteMany({ where: { token: reusedHash } });
    }
  });

  it("revokes a refresh-token family when a rotated token is reused", async () => {
    const { db } = await import("@weldall/db");
    await db.oAuthDeviceRefreshBinding.updateMany({
      where: { userId },
      data: { rotatedAt: new Date(), revokedAt: null },
    });
    const proof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: proof,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: WELDALL_CLIENT_ID,
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
    const binding = await db.oAuthDeviceRefreshBinding.findFirstOrThrow({ where: { userId } });
    expect(binding.revokedAt).toBeInstanceOf(Date);
  });

  it("makes revocation of unknown or already revoked tokens idempotent", async () => {
    const { revocationFacade } = await import("../src/server/oauth/facade.js");
    for (const token of ["unknown-refresh-token", refreshToken]) {
      const response = await revocationFacade(
        new Request(WELDALL_REVOCATION_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token,
            token_type_hint: "refresh_token",
            client_id: WELDALL_CLIENT_ID,
          }),
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("");
    }
  });

  it("returns invalid_request for malformed OAuth media types", async () => {
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    const response = await tokenFacade(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        body: "grant_type=refresh_token",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("rejects duplicate revocation hints", async () => {
    const { revocationFacade } = await import("../src/server/oauth/facade.js");
    const body = new URLSearchParams({
      token: "unknown-refresh-token",
      token_type_hint: "refresh_token",
      client_id: WELDALL_CLIENT_ID,
    });
    body.append("token_type_hint", "access_token");
    const response = await revocationFacade(
      new Request(WELDALL_REVOCATION_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });
});
