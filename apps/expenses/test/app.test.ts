import { beforeAll, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import {
  DOWNSTREAM_CLIENT_ID,
  EXPENSES_ISSUER,
  EXPENSES_RESOURCE,
  EXPENSES_TOKEN_ENDPOINT,
  ID_JAG_DRAFT,
  JWT_DPOP_GRANT,
  WELDALL_ISSUER,
  createDpopProof,
  generateEs256KeyPair,
  issueIdJag,
  signEs256,
  type DpopKeyPair,
} from "@weldall/oauth";

let weldallKey: DpopKeyPair;
let expensesKey: DpopKeyPair;
let deviceKey: DpopKeyPair;

beforeAll(async () => {
  weldallKey = await generateEs256KeyPair();
  expensesKey = await generateEs256KeyPair();
  deviceKey = await generateEs256KeyPair();
  const k = weldallKey,
    e = expensesKey;
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
      },
      body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
    });
    expect(exchange.status).toBe(200);
    const token = ((await exchange.json()) as { access_token: string }).access_token;
    const decoded = decodeJwt(token);
    expect(decoded).toMatchObject({
      iss: EXPENSES_ISSUER,
      sub: "weldall-user",
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
    const apiHeaders = { authorization: `DPoP ${token}`, dpop: apiProof };
    const success = await app.request("/api/expenses", { headers: apiHeaders });
    expect(success.status, await success.clone().text()).toBe(200);
    await expect(success.json()).resolves.toMatchObject({ subject: "weldall-user" });

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
