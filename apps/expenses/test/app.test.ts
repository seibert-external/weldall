import { beforeAll, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import {
  ID_JAG_DRAFT,
  JWT_DPOP_GRANT,
  createDpopProof,
  generateEs256KeyPair,
  issueIdJag as issueSdkIdJag,
  signEs256,
  type DpopKeyPair,
} from "@weldall/sdk";
import {
  DOWNSTREAM_CLIENT_ID,
  EXPENSES_ISSUER,
  EXPENSES_RESOURCE,
  EXPENSES_TOKEN_ENDPOINT,
  WELDALL_ISSUER,
} from "../src/constants.js";

let weldallKey: DpopKeyPair;
let expensesKey: DpopKeyPair;
let deviceKey: DpopKeyPair;

const issueIdJag = (input: Omit<Parameters<typeof issueSdkIdJag>[0], "email">) =>
  issueSdkIdJag({ ...input, email: "user@example.com" });

beforeAll(async () => {
  weldallKey = await generateEs256KeyPair();
  expensesKey = await generateEs256KeyPair();
  deviceKey = await generateEs256KeyPair();
  const k = weldallKey,
    e = expensesKey;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${WELDALL_ISSUER}/.well-known/oauth-authorization-server`)
      return Response.json({
        issuer: WELDALL_ISSUER,
        jwks_uri: `${WELDALL_ISSUER}/.well-known/jwks.json`,
      });
    if (url === `${WELDALL_ISSUER}/.well-known/jwks.json`)
      return Response.json({ keys: [{ ...k.publicJwk, kid: "k", alg: "ES256", use: "sig" }] });
    return new Response(null, { status: 404 });
  });
  Object.assign(process.env, {
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(k.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(k.publicJwk),
    WELDALL_SIGNING_KID: "k",
    EXPENSES_SIGNING_PRIVATE_JWK: JSON.stringify(e.privateJwk),
    EXPENSES_SIGNING_PUBLIC_JWK: JSON.stringify(e.publicJwk),
    EXPENSES_SIGNING_KID: "e",
  });
});
describe("Expenses", () => {
  it("serves the development browser fixture with strict CSP and workspace browser modules", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const page = await app.request("/weldall-browser");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    for (const label of [
      "Start connection",
      "Local status",
      "Verify remotely",
      "Read expenses",
      "Create expense",
      "Disconnect remotely",
      "Clear local credentials",
    ])
      expect(html).toContain(label);
    const script = await app.request("/weldall-browser/app.js");
    expect(await script.text()).toContain('from "/weldall-browser/sdk/index.js"');
    const sdk = await app.request("/weldall-browser/sdk/index.js");
    expect(sdk.status).toBe(200);
    expect(await sdk.text()).toContain("createWeldallBrowserClient");
    expect((await app.request("/weldall-browser/sdk/../package.json")).status).toBe(404);
  });

  it("fails closed for the development browser fixture in production", async () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { createApp } = await import("../src/app.js");
      const app = await createApp();
      expect((await app.request("/weldall-browser")).status).toBe(404);
      expect((await app.request("/weldall-browser/app.js")).status).toBe(404);
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("allows only the explicit system-test fixture opt-in in a production process", async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorEnabled = process.env.WELDALL_BROWSER_FIXTURE_ENABLED;
    process.env.NODE_ENV = "production";
    process.env.WELDALL_BROWSER_FIXTURE_ENABLED = "true";
    try {
      const { createApp } = await import("../src/app.js");
      const app = await createApp();
      expect((await app.request("/weldall-browser")).status).toBe(200);
      expect((await app.request("/weldall-browser/sdk/index.js")).status).toBe(200);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      if (priorEnabled === undefined) delete process.env.WELDALL_BROWSER_FIXTURE_ENABLED;
      else process.env.WELDALL_BROWSER_FIXTURE_ENABLED = priorEnabled;
    }
  });

  it("handles exact-origin API preflight before authentication and decorates errors", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const preflight = await app.request("/api/expenses", {
      method: "OPTIONS",
      headers: {
        origin: EXPENSES_ISSUER,
        "access-control-request-method": "GET",
        "access-control-request-headers":
          "Authorization, DPoP, Content-Type, X-Request-Id, X-Correlation-Id",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(EXPENSES_ISSUER);
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Request-Id");
    const wrongMethod = await app.request("/api/expenses", {
      method: "OPTIONS",
      headers: {
        origin: EXPENSES_ISSUER,
        "access-control-request-method": "DELETE",
      },
    });
    expect(wrongMethod.status).toBe(403);
    const missingRoute = await app.request("/api/not-registered", {
      method: "OPTIONS",
      headers: {
        origin: EXPENSES_ISSUER,
        "access-control-request-method": "GET",
      },
    });
    expect(missingRoute.status).toBe(404);
    const error = await app.request("/api/expenses", { headers: { origin: EXPENSES_ISSUER } });
    expect(error.status).toBe(401);
    expect(error.headers.get("access-control-allow-origin")).toBe(EXPENSES_ISSUER);
    expect(error.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    const rejected = await app.request("/api/expenses", {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
      },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("publishes a DB-free AS", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const r = await app.request("/.well-known/oauth-authorization-server");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ issuer: "https://expenses.seibert.localdev" });
  });
  it("rejects unsupported grants", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const r = await app.request("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "bad" }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects an ID-JAG presented by a different device key", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const attacker = await generateEs256KeyPair();
    const assertion = await issueIdJag({
      issuer: WELDALL_ISSUER,
      subject: "weldall-user",
      audience: EXPENSES_ISSUER,
      clientId: DOWNSTREAM_CLIENT_ID,
      resource: EXPENSES_RESOURCE,
      scopes: ["expenses:read"],
      jkt: deviceKey.jkt,
      kid: "k",
      privateJwk: weldallKey.privateJwk,
    });
    const proof = await createDpopProof({
      ...attacker,
      method: "POST",
      url: EXPENSES_TOKEN_ENDPOINT,
    });
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
      body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });
  });

  it("rejects an ID-JAG intended for another authorization server", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const assertion = await issueIdJag({
      issuer: WELDALL_ISSUER,
      subject: "weldall-user",
      audience: "https://attacker.example",
      clientId: DOWNSTREAM_CLIENT_ID,
      resource: EXPENSES_RESOURCE,
      scopes: ["expenses:read"],
      jkt: deviceKey.jkt,
      kid: "k",
      privateJwk: weldallKey.privateJwk,
    });
    const proof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: EXPENSES_TOKEN_ENDPOINT,
    });
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
      body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("rejects an ID-JAG with an empty confirmation thumbprint", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signEs256(
      {
        iss: WELDALL_ISSUER,
        sub: "weldall-user",
        email: "user@example.com",
        email_verified: true,
        aud: EXPENSES_ISSUER,
        client_id: DOWNSTREAM_CLIENT_ID,
        resource: EXPENSES_RESOURCE,
        scope: "expenses:read",
        cnf: { jkt: "" },
        jti: "empty-binding",
        iat: now,
        exp: now + 300,
        "urn:weldall:id-jag-draft": ID_JAG_DRAFT,
      },
      { kid: "k", privateJwk: weldallKey.privateJwk, typ: "oauth-id-jag+jwt" },
    );
    const attacker = await generateEs256KeyPair();
    const proof = await createDpopProof({
      ...attacker,
      method: "POST",
      url: EXPENSES_TOKEN_ENDPOINT,
    });
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
      body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("atomically accepts only one parallel exchange of an ID-JAG", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const assertion = await issueIdJag({
      issuer: WELDALL_ISSUER,
      subject: "parallel-user",
      audience: EXPENSES_ISSUER,
      clientId: DOWNSTREAM_CLIENT_ID,
      resource: EXPENSES_RESOURCE,
      scopes: ["expenses:read"],
      jkt: deviceKey.jkt,
      kid: "k",
      privateJwk: weldallKey.privateJwk,
    });
    const request = async () => {
      const proof = await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: EXPENSES_TOKEN_ENDPOINT,
      });
      return app.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
        body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
      });
    };
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const rejected = responses.find((response) => response.status === 400)!;
    await expect(rejected.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("rejects duplicate token parameters", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const assertion = await issueIdJag({
      issuer: WELDALL_ISSUER,
      subject: "weldall-user",
      audience: EXPENSES_ISSUER,
      clientId: DOWNSTREAM_CLIENT_ID,
      resource: EXPENSES_RESOURCE,
      scopes: ["expenses:read"],
      jkt: deviceKey.jkt,
      kid: "k",
      privateJwk: weldallKey.privateJwk,
    });
    const body = new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion });
    body.append("assertion", assertion);
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("maps malformed compact DPoP to invalid_dpop_proof", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const assertion = await issueIdJag({
      issuer: WELDALL_ISSUER,
      subject: "weldall-user",
      audience: EXPENSES_ISSUER,
      clientId: DOWNSTREAM_CLIENT_ID,
      resource: EXPENSES_RESOURCE,
      scopes: ["expenses:read"],
      jkt: deviceKey.jkt,
      kid: "k",
      privateJwk: weldallKey.privateJwk,
    });
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: "not-a-jwt" },
      body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });
  });

  it("exchanges a key-bound ID-JAG and enforces API scopes, ath, and replay", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const assertion = await issueIdJag({
      issuer: WELDALL_ISSUER,
      subject: "weldall-user",
      audience: EXPENSES_ISSUER,
      clientId: DOWNSTREAM_CLIENT_ID,
      resource: EXPENSES_RESOURCE,
      scopes: ["expenses:read"],
      jkt: deviceKey.jkt,
      kid: "k",
      privateJwk: weldallKey.privateJwk,
    });
    const exchangeProof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: EXPENSES_TOKEN_ENDPOINT,
    });
    const exchange = await app.request("/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        dpop: exchangeProof,
        origin: EXPENSES_ISSUER,
      },
      body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get("access-control-allow-origin")).toBe(EXPENSES_ISSUER);
    const token = ((await exchange.json()) as { access_token: string }).access_token;
    const decoded = decodeJwt(token);
    expect(decoded).toMatchObject({
      iss: EXPENSES_ISSUER,
      sub: "weldall-user",
      email: "user@example.com",
      email_verified: true,
      aud: EXPENSES_RESOURCE,
      client_id: DOWNSTREAM_CLIENT_ID,
      scope: "expenses:read",
      cnf: { jkt: deviceKey.jkt },
      jti: expect.any(String),
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    const apiUrl = `${EXPENSES_RESOURCE}/expenses`;
    const apiProof = await createDpopProof({
      ...deviceKey,
      method: "GET",
      url: apiUrl,
      accessToken: token,
    });
    const apiHeaders = {
      authorization: `DPoP ${token}`,
      dpop: apiProof,
      origin: EXPENSES_ISSUER,
    };
    const success = await app.request("/api/expenses", { headers: apiHeaders });
    expect(success.status, await success.clone().text()).toBe(200);
    expect(success.headers.get("access-control-allow-origin")).toBe(EXPENSES_ISSUER);
    await expect(success.json()).resolves.toMatchObject({
      subject: "weldall-user",
      email: "user@example.com",
    });

    const proofReplay = await app.request("/api/expenses", { headers: apiHeaders });
    expect(proofReplay.status).toBe(401);
    await expect(proofReplay.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });

    const deleteProof = await createDpopProof({
      ...deviceKey,
      method: "DELETE",
      url: `${apiUrl}/expense-1`,
      accessToken: token,
    });
    const missingScope = await app.request("/api/expenses/expense-1", {
      method: "DELETE",
      headers: { authorization: `DPoP ${token}`, dpop: deleteProof },
    });
    expect(missingScope.status).toBe(403);

    const freshExchangeProof = await createDpopProof({
      ...deviceKey,
      method: "POST",
      url: EXPENSES_TOKEN_ENDPOINT,
    });
    const grantReplay = await app.request("/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        dpop: freshExchangeProof,
      },
      body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
    });
    expect(grantReplay.status).toBe(400);
    await expect(grantReplay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });
});
