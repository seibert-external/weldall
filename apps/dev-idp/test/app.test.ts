import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { generateEs256KeyPair, type DpopKeyPair } from "@weldall/sdk";
import { createApp } from "../src/app.js";
import type { DevIdpEnv } from "../src/env.js";

let key: DpopKeyPair;
let env: DevIdpEnv;

beforeAll(async () => {
  key = await generateEs256KeyPair();
  env = {
    issuer: "https://dev-idp.example",
    clientId: "weldall",
    clientSecret: "development-client-secret",
    redirectUri: "http://localhost:3000/api/auth/callback/dev-oidc",
    signingKid: "dev-idp-test",
    privateJwk: key.privateJwk,
    publicJwk: key.publicJwk,
    users: [
      {
        sub: "alice",
        email: "alice@example.com",
        name: "Alice",
        emailVerified: true,
      },
    ],
  };
});

const authorizationUrl = (verifier: string) => {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("/authorize", env.issuer);
  Object.entries({
    response_type: "code",
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    scope: "openid email profile",
    state: "state",
    nonce: "nonce",
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).forEach(([name, value]) => url.searchParams.set(name, value));
  return url;
};

const authorize = async (app: ReturnType<typeof createApp>, verifier: string) => {
  const page = await app.request(authorizationUrl(verifier));
  expect(page.status).toBe(200);
  const transaction = (await page.text()).match(/name="transaction" value="([^"]+)"/)?.[1];
  expect(transaction).toBeTruthy();
  const login = await app.request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction: transaction!, email: "alice@example.com" }),
  });
  expect(login.status).toBe(302);
  return new URL(login.headers.get("location")!).searchParams.get("code")!;
};

const exchange = (app: ReturnType<typeof createApp>, code: string, verifier: string) =>
  app.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: env.redirectUri,
      code_verifier: verifier,
    }),
  });

describe("development OIDC provider", () => {
  it("rejects incomplete authorization requests", async () => {
    const response = await createApp(env).request("/authorize?client_id=weldall");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("issues a nonce-bound ID token for an allowlisted identity", async () => {
    const app = createApp(env);
    const verifier = "v".repeat(64);
    const response = await exchange(app, await authorize(app, verifier), verifier);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id_token: string; access_token: string };
    const jwks: JSONWebKeySet = {
      keys: [{ ...key.publicJwk, kid: env.signingKid, alg: "ES256" }],
    };
    await expect(
      jwtVerify(body.id_token, createLocalJWKSet(jwks), {
        issuer: env.issuer,
        audience: env.clientId,
        algorithms: ["ES256"],
      }),
    ).resolves.toMatchObject({ payload: { sub: "alice", nonce: "nonce" } });
    const userInfo = await app.request("/userinfo", {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    await expect(userInfo.json()).resolves.toMatchObject({ sub: "alice", email_verified: true });
  });

  it("consumes an authorization code after a failed PKCE attempt", async () => {
    const app = createApp(env);
    const verifier = "v".repeat(64);
    const code = await authorize(app, verifier);
    expect((await exchange(app, code, "x".repeat(64))).status).toBe(400);
    const replay = await exchange(app, code, verifier);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("rejects replay of a successfully consumed authorization code", async () => {
    const app = createApp(env);
    const verifier = "v".repeat(64);
    const code = await authorize(app, verifier);
    expect((await exchange(app, code, verifier)).status).toBe(200);
    const replay = await exchange(app, code, verifier);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it.each([
    ["plain PKCE", (url: URL) => url.searchParams.set("code_challenge_method", "plain")],
    ["short challenge", (url: URL) => url.searchParams.set("code_challenge", "short")],
    ["wrong redirect", (url: URL) => url.searchParams.set("redirect_uri", "https://evil.test")],
    ["duplicate state", (url: URL) => url.searchParams.append("state", "second")],
    ["duplicate nonce", (url: URL) => url.searchParams.append("nonce", "second")],
  ])("rejects authorization requests with %s", async (_name, mutate) => {
    const url = authorizationUrl("v".repeat(64));
    mutate(url);
    const response = await createApp(env).request(url);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("rejects a verifier outside the RFC 7636 length bounds", async () => {
    const app = createApp(env);
    const verifier = "short";
    const code = await authorize(app, verifier);
    const response = await exchange(app, code, verifier);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("rejects duplicate token parameters", async () => {
    const app = createApp(env);
    const verifier = "v".repeat(64);
    const code = await authorize(app, verifier);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: env.redirectUri,
      code_verifier: verifier,
    });
    body.append("code", code);
    const response = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });
});
