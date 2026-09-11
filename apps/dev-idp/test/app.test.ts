import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { generateEs256KeyPair, type DpopKeyPair } from "@weldall/sdk";
import { createApp } from "../src/app.js";
import type { DevIdpEnv } from "../src/env.js";

let key: DpopKeyPair;
let jwks: JSONWebKeySet;
let env: DevIdpEnv;
const redirectUri =
  "https://weldall.example.com/api/auth/callback/0195be74-d5e4-4543-8fcf-4fe368d74214";

beforeAll(async () => {
  key = await generateEs256KeyPair();
  env = {
    issuer: "https://dev-idp.example",
    clientId: "weldall",
    clientSecret: "development-client-secret",
    callbackOrigin: "https://weldall.example.com",
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
  jwks = { keys: [{ ...key.publicJwk, kid: env.signingKid, alg: "ES256" }] };
});

const authorizationUrl = (verifier: string) => {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("/authorize", env.issuer);
  Object.entries({
    response_type: "code",
    client_id: env.clientId,
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state: "state",
    nonce: "nonce",
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).forEach(([name, value]) => url.searchParams.set(name, value));
  return url;
};

const startAuthorization = async (app: ReturnType<typeof createApp>, verifier: string) => {
  const page = await app.request(authorizationUrl(verifier));
  expect(page.status).toBe(200);
  const transaction = (await page.text()).match(/name="transaction" value="([^"]+)"/)?.[1];
  expect(transaction).toBeTruthy();
  return transaction!;
};

const submitLogin = (app: ReturnType<typeof createApp>, transaction: string, email: string) =>
  app.request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, email }),
  });

const authorize = async (
  app: ReturnType<typeof createApp>,
  verifier: string,
  email = "alice@example.com",
) => {
  const login = await submitLogin(app, await startAuthorization(app, verifier), email);
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
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

const issuedToken = async (response: Response) => {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id_token: string; access_token: string };
  const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(jwks), {
    issuer: env.issuer,
    audience: env.clientId,
    algorithms: ["ES256"],
  });
  return { payload, body };
};

const loginAs = async (app: ReturnType<typeof createApp>, email: string) => {
  const verifier = "v".repeat(64);
  return exchange(app, await authorize(app, verifier, email), verifier);
};

describe("development OIDC provider", () => {
  it("rejects incomplete authorization requests", async () => {
    const response = await createApp(env).request("/authorize?client_id=weldall");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("renders a text input that suggests configured identities", async () => {
    const page = await createApp(env).request(authorizationUrl("v".repeat(64)));
    expect(page.status).toBe(200);
    const body = await page.text();
    const input = body.match(/<input[^>]*id="email"[^>]*>/)?.[0];
    expect(input).toContain('type="email"');
    expect(input).toContain('value="alice@example.com"');
    expect(body).not.toContain("<select");
    expect(body).toContain('<option value="alice@example.com"></option>');
    // The page is themed by the Astryx neutral theme the Weldall app loads, not by local colors.
    expect(body).toContain('<html lang="en" data-astryx-theme="neutral">');
    expect(body).toContain('class="login-shell"');
    expect(body).toContain('class="login-panel"');
    const styles = body.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    expect(styles).toBeTruthy();
    expect(styles).toContain('@scope ([data-astryx-theme="neutral"])');
    expect(styles).toContain("--color-background-surface: light-dark(#ffffff, #262626)");
    expect(styles).toContain("--size-element-md:32px");
    // The CSP must keep allowing exactly the inline style block the page ships with.
    expect(page.headers.get("content-security-policy")).toContain(
      `style-src 'sha256-${createHash("sha256").update(styles!).digest("base64")}'`,
    );
  });

  it.each([
    ["weldall-theme=dark", ' data-theme="dark"'],
    ["weldall-theme=light", ' data-theme="light"'],
    ["weldall-theme=system", ""],
  ])("mirrors the Weldall theme cookie %s", async (cookie, attribute) => {
    const page = await createApp(env).request(authorizationUrl("v".repeat(64)), {
      headers: { cookie },
    });
    const body = await page.text();
    expect(body).toContain(`<html lang="en" data-astryx-theme="neutral"${attribute}>`);
  });

  it("issues a nonce-bound ID token for an allowlisted identity", async () => {
    const app = createApp(env);
    const verifier = "v".repeat(64);
    const { payload, body } = await issuedToken(
      await exchange(app, await authorize(app, verifier), verifier),
    );
    expect(payload).toMatchObject({ sub: "alice", nonce: "nonce" });
    const userInfo = await app.request("/userinfo", {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    await expect(userInfo.json()).resolves.toMatchObject({ sub: "alice", email_verified: true });
  });

  it("matches a configured identity regardless of case and surrounding whitespace", async () => {
    const { payload } = await issuedToken(await loginAs(createApp(env), " ALICE@Example.COM "));
    expect(payload).toMatchObject({ sub: "alice", email: "alice@example.com" });
  });

  it("derives a stable verified identity for an unconfigured email", async () => {
    const app = createApp(env);
    const first = await issuedToken(await loginAs(app, " Bob.Roe+test@Example.com "));
    const second = await issuedToken(await loginAs(app, "bob.roe+test@example.com"));
    expect(first.payload).toMatchObject({
      email: "bob.roe+test@example.com",
      email_verified: true,
      name: "Bob Roe Test",
    });
    expect(first.payload.sub).toMatch(/^dev-bob-roe-test-[0-9a-f]{12}$/);
    expect(second.payload.sub).toBe(first.payload.sub);
  });

  it("keeps the login transaction after a malformed email", async () => {
    const app = createApp(env);
    const verifier = "v".repeat(64);
    const transaction = await startAuthorization(app, verifier);
    const rejected = await submitLogin(app, transaction, "not-an-email");
    expect(rejected.status).toBe(400);
    const body = await rejected.text();
    expect(body).toContain("Enter a valid email address");
    expect(body).toContain(`name="transaction" value="${transaction}"`);
    expect(body).toContain('value="not-an-email"');
    expect((await submitLogin(app, transaction, "alice@example.com")).status).toBe(302);
  });

  it("consumes the login transaction after a successful login", async () => {
    const app = createApp(env);
    const transaction = await startAuthorization(app, "v".repeat(64));
    expect((await submitLogin(app, transaction, "alice@example.com")).status).toBe(302);
    const replay = await submitLogin(app, transaction, "alice@example.com");
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_request" });
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
      redirect_uri: redirectUri,
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
