import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, ensureSystemScopes, LOGIN_SCOPE_KEY } from "@weldall/db";
import { denyCliConsentWithoutLoginScope } from "../src/server/auth/consent.js";
import {
  hasLoginScopeForEmail,
  requireLoginScopeForOAuthGrant,
} from "../src/server/auth/login-policy.js";
import { WELDALL_CLIENT_ID, WELDALL_ISSUER } from "../src/server/oauth/constants.js";

const runId = randomUUID();
const allowedUserId = `login-allowed-${runId}`;
const deniedUserId = `login-denied-${runId}`;
const allowedEmail = `login-allowed-${runId}@example.com`;
const deniedEmail = `login-denied-${runId}@example.com`;
let assignmentId: string;
let loginScopeId: string;

beforeAll(async () => {
  await ensureSystemScopes(db, "login-policy-test");
  const loginScope = await db.scope.findUniqueOrThrow({ where: { key: LOGIN_SCOPE_KEY } });
  loginScopeId = loginScope.id;
  await db.user.createMany({
    data: [
      {
        id: allowedUserId,
        name: "Allowed Login",
        email: allowedEmail,
        emailVerified: true,
      },
      {
        id: deniedUserId,
        name: "Denied Login",
        email: deniedEmail,
        emailVerified: true,
      },
    ],
  });
  const assignment = await db.emailScopeAssignment.create({
    data: {
      normalizedEmail: allowedEmail,
      createdBy: "login-policy-test",
      updatedBy: "login-policy-test",
      grants: {
        create: {
          id: randomUUID(),
          scopeId: loginScopeId,
          createdBy: "login-policy-test",
        },
      },
    },
  });
  assignmentId = assignment.id;
});

afterAll(async () => {
  await db.session.deleteMany({ where: { userId: { in: [allowedUserId, deniedUserId] } } });
  await db.emailScopeAssignment.deleteMany({
    where: { normalizedEmail: { in: [allowedEmail, deniedEmail] } },
  });
  await db.user.deleteMany({ where: { id: { in: [allowedUserId, deniedUserId] } } });
});

describe("weldall:login policy", () => {
  it("resolves the direct assignment without exposing it to browser auth", async () => {
    await expect(hasLoginScopeForEmail(allowedEmail.toUpperCase())).resolves.toBe(true);
    await expect(hasLoginScopeForEmail(deniedEmail)).resolves.toBe(false);
  });

  it("leaves browser session creation unchanged for a user without the scope", async () => {
    Object.assign(process.env, {
      ENABLE_DEV_LOGIN: "false",
      GOOGLE_CLIENT_ID: "browser-regression-test-client",
      GOOGLE_CLIENT_SECRET: "browser-regression-test-secret",
      WELDALL_DEPLOYMENT_MODE: "development",
    });
    const { auth } = await import("../src/server/auth/auth.js");
    const context = await auth.$context;
    expect(context.options.user?.validateUserInfo).toBeUndefined();
    expect(context.options.databaseHooks?.session?.create?.before).toBeUndefined();
    expect(context.options.databaseHooks?.session?.update?.before).toBeUndefined();
    const oauthProviderPlugin = context.options.plugins?.find(
      (plugin) => plugin.id === "oauth-provider",
    );
    expect(oauthProviderPlugin?.options).toMatchObject({
      customTokenResponseFields: requireLoginScopeForOAuthGrant,
    });
    const session = await context.internalAdapter.createSession(deniedUserId);
    expect(session).toMatchObject({ userId: deniedUserId });
    await db.session.deleteMany({ where: { userId: deniedUserId } });
  });

  it("gates both CLI authorization-code login and refresh grants", async () => {
    for (const grantType of ["authorization_code", "refresh_token"]) {
      await expect(
        requireLoginScopeForOAuthGrant({ grantType, user: { id: allowedUserId } }),
      ).resolves.toEqual({});
      await expect(
        requireLoginScopeForOAuthGrant({ grantType, user: { id: deniedUserId } }),
      ).rejects.toMatchObject({
        body: {
          error: "invalid_grant",
          error_description: "the weldall:login scope must be assigned to your account",
        },
      });
    }
  });

  it("returns a loopback OAuth error for accepted CLI consent without weldall:login", async () => {
    const oauthQuery = new URLSearchParams({
      client_id: WELDALL_CLIENT_ID,
      redirect_uri: "http://127.0.0.1:43123/callback",
      state: "denied-state",
    });
    const response = await denyCliConsentWithoutLoginScope(
      new Request(`${WELDALL_ISSUER}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true, oauth_query: oauthQuery.toString() }),
      }),
      { user: { id: deniedUserId } },
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { redirect?: unknown; url?: unknown };
    expect(body.redirect).toBe(true);
    expect(typeof body.url).toBe("string");
    const callback = new URL(body.url as string);
    expect(callback.origin).toBe("http://127.0.0.1:43123");
    expect(callback.pathname).toBe("/callback");
    expect(callback.searchParams.get("error")).toBe("invalid_grant");
    expect(callback.searchParams.get("error_description")).toBe("invalid grant");
    expect(callback.searchParams.get("iss")).toBe(WELDALL_ISSUER);
    expect(callback.searchParams.get("state")).toBe("denied-state");
  });

  it("passes through accepted CLI consent for direct weldall:login assignments", async () => {
    const oauthQuery = new URLSearchParams({
      client_id: WELDALL_CLIENT_ID,
      redirect_uri: "http://127.0.0.1:43123/callback",
      state: "allowed-state",
    });
    await expect(
      denyCliConsentWithoutLoginScope(
        new Request(`${WELDALL_ISSUER}/api/auth/oauth2/consent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accept: true, oauth_query: oauthQuery.toString() }),
        }),
        { user: { id: allowedUserId } },
      ),
    ).resolves.toBeNull();
  });

  it("does not alter non-CLI consent handling", async () => {
    const oauthQuery = new URLSearchParams({
      client_id: "browser-client",
      redirect_uri: "https://client.example/callback",
      state: "browser-state",
    });
    await expect(
      denyCliConsentWithoutLoginScope(
        new Request(`${WELDALL_ISSUER}/api/auth/oauth2/consent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accept: true, oauth_query: oauthQuery.toString() }),
        }),
        { user: { id: deniedUserId } },
      ),
    ).resolves.toBeNull();
  });

  it("does not synthesize CLI consent redirects for non-loopback redirect URIs", async () => {
    const oauthQuery = new URLSearchParams({
      client_id: WELDALL_CLIENT_ID,
      redirect_uri: "https://client.example/callback",
      state: "external-state",
    });
    await expect(
      denyCliConsentWithoutLoginScope(
        new Request(`${WELDALL_ISSUER}/api/auth/oauth2/consent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accept: true, oauth_query: oauthQuery.toString() }),
        }),
        { user: { id: deniedUserId } },
      ),
    ).resolves.toBeNull();
  });

  it("blocks the next CLI refresh after the scope is revoked", async () => {
    await db.emailScopeGrant.deleteMany({ where: { assignmentId, scopeId: loginScopeId } });
    try {
      await expect(
        requireLoginScopeForOAuthGrant({
          grantType: "refresh_token",
          user: { id: allowedUserId },
        }),
      ).rejects.toMatchObject({ body: { error: "invalid_grant" } });
    } finally {
      await db.emailScopeGrant.create({
        data: {
          id: randomUUID(),
          assignmentId,
          scopeId: loginScopeId,
          createdBy: "login-policy-test",
        },
      });
    }
  });
});
