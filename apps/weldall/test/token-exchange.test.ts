import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOWNSTREAM_CLIENT_ID,
  EXPENSES_ISSUER,
  EXPENSES_RESOURCE,
  ID_JAG_TOKEN_TYPE,
  WELDALL_CLIENT_ID,
  WELDALL_ISSUER,
  WELDALL_REVOCATION_ENDPOINT,
  WELDALL_TOKEN_ENDPOINT,
  REFRESH_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  createDpopProof,
  generateEs256KeyPair,
  verifyIdJag,
  type DpopKeyPair,
} from "@weldall/oauth";

const userId = "weldall-token-exchange-test-user";
const email = "token-exchange-test@example.com";
const refreshToken = "test-refresh-token-never-issued";
let issuerKey: DpopKeyPair;
let deviceKey: DpopKeyPair;

beforeAll(async () => {
  issuerKey = await generateEs256KeyPair();
  deviceKey = await generateEs256KeyPair();
  Object.assign(process.env, {
    POSTGRES_URL: "postgresql://postgres@localhost:5433/postgres",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
    OAUTH_PROXY_SECRET: "test-oauth-proxy-secret-at-least-32-characters",
    GOOGLE_CLIENT_ID: "google-test-client",
    GOOGLE_CLIENT_SECRET: "google-test-secret",
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
    WELDALL_SIGNING_KID: "weldall-token-exchange-test",
  });
  const { db } = await import("@weldall/db");
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
  const readScope = await db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } });
  await db.emailScopeGrant.deleteMany({ where: { assignmentId: assignment.id } });
  await db.emailScopeGrant.create({
    data: {
      id: randomUUID(),
      assignmentId: assignment.id,
      scopeId: readScope.id,
      createdBy: "token-exchange-test",
    },
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
  await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: email } });
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
    await expect(
      verifyIdJag(body.access_token, {
        issuer: WELDALL_ISSUER,
        audience: EXPENSES_ISSUER,
        resource: EXPENSES_RESOURCE,
        clientId: DOWNSTREAM_CLIENT_ID,
        kid: "weldall-token-exchange-test",
        publicJwk: issuerKey.publicJwk,
        allowedScopes: ["expenses:read"],
      }),
    ).resolves.toMatchObject({ sub: userId, cnf: { jkt: deviceKey.jkt } });
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

    const duplicate = base();
    duplicate.set("scope", "expenses:read");
    duplicate.append("audience", "https://attacker.example");
    const duplicateResponse = await makeRequest(duplicate);
    expect(duplicateResponse.status).toBe(400);
    await expect(duplicateResponse.json()).resolves.toMatchObject({ error: "invalid_request" });
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
