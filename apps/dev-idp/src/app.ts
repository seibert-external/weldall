import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { SignJWT, importJWK } from "jose";
import type { DevIdpEnv, DevIdpUser } from "./env.js";

type AuthorizationTransaction = {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
};

type AuthorizationCode = AuthorizationTransaction & {
  user: DevIdpUser;
};

const noStore = { "cache-control": "no-store", pragma: "no-cache" };
const base64urlSha256 = (value: string) =>
  createHash("sha256").update(value, "ascii").digest("base64url");
const randomValue = () => randomBytes(32).toString("base64url");
const pkceChallenge = /^[A-Za-z0-9_-]{43}$/;
const pkceVerifier = /^[A-Za-z0-9._~-]{43,128}$/;
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const html = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[character]!;
  });

export function createApp(env: DevIdpEnv) {
  // This insecure fixture accepts only server-generated provider callbacks at its configured Weldall origin.
  const validCallback = (value: string | undefined) => {
    try {
      const url = new URL(value ?? "");
      return (
        url.origin === env.callbackOrigin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/api\/auth\/callback\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          url.pathname,
        )
      );
    } catch {
      return false;
    }
  };
  const transactions = new Map<string, AuthorizationTransaction>();
  const codes = new Map<string, AuthorizationCode>();
  const accessTokens = new Map<string, { user: DevIdpUser; expiresAt: number }>();
  const app = new Hono();

  const oauthError = (error: string, description: string, status: 400 | 401 = 400) =>
    new Response(JSON.stringify({ error, error_description: description }), {
      status,
      headers: { ...noStore, "content-type": "application/json" },
    });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer: env.issuer,
      authorization_endpoint: `${env.issuer}/authorize`,
      token_endpoint: `${env.issuer}/token`,
      userinfo_endpoint: `${env.issuer}/userinfo`,
      jwks_uri: `${env.issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
      scopes_supported: ["openid", "email", "profile"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    }),
  );
  app.get("/jwks", (c) =>
    c.json({ keys: [{ ...env.publicJwk, kid: env.signingKid, alg: "ES256", use: "sig" }] }),
  );

  app.get("/authorize", (c) => {
    const requestUrl = new URL(c.req.url);
    const requiredParameters = [
      "response_type",
      "client_id",
      "redirect_uri",
      "scope",
      "state",
      "nonce",
      "code_challenge_method",
      "code_challenge",
    ];
    const query = c.req.query();
    if (
      requiredParameters.some((name) => requestUrl.searchParams.getAll(name).length !== 1) ||
      query.response_type !== "code" ||
      query.client_id !== env.clientId ||
      !query.redirect_uri ||
      !validCallback(query.redirect_uri) ||
      !query.state ||
      !query.nonce ||
      query.code_challenge_method !== "S256" ||
      !query.code_challenge ||
      !pkceChallenge.test(query.code_challenge) ||
      !query.scope?.split(" ").includes("openid")
    )
      return oauthError("invalid_request", "invalid authorization request");
    const transaction = randomValue();
    transactions.set(transaction, {
      clientId: query.client_id,
      redirectUri: query.redirect_uri,
      state: query.state,
      nonce: query.nonce,
      codeChallenge: query.code_challenge,
      scope: query.scope,
      expiresAt: Date.now() + 60_000,
    });
    const options = env.users
      .map((user) => `<option value="${html(user.email)}">${html(user.email)}</option>`)
      .join("");
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Development login</title></head><body><main><h1>Insecure development login</h1><p>Choose a configured test identity. No password is required.</p><form method="post" action="/login"><input type="hidden" name="transaction" value="${transaction}"><label for="email">Email</label><select id="email" name="email" required>${options}</select><button type="submit">Continue</button></form></main></body></html>`,
      200,
      {
        ...noStore,
        "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    );
  });

  app.post("/login", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const transactionId = typeof body.transaction === "string" ? body.transaction : "";
    const transaction = transactions.get(transactionId);
    transactions.delete(transactionId);
    if (!transaction || transaction.expiresAt < Date.now())
      return oauthError("invalid_request", "invalid or expired login transaction");
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const user = env.users.find((candidate) => candidate.email.toLowerCase() === email);
    if (!user) return oauthError("access_denied", "unknown development identity", 401);
    const code = randomValue();
    codes.set(code, { ...transaction, user });
    const redirect = new URL(transaction.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", transaction.state);
    redirect.searchParams.set("iss", env.issuer);
    return c.redirect(redirect.toString());
  });

  app.post("/token", async (c) => {
    const body = await c.req.parseBody({ all: true });
    if (
      body.grant_type !== "authorization_code" ||
      typeof body.code !== "string" ||
      typeof body.client_id !== "string" ||
      typeof body.client_secret !== "string" ||
      typeof body.redirect_uri !== "string" ||
      typeof body.code_verifier !== "string" ||
      !pkceVerifier.test(body.code_verifier)
    )
      return oauthError("invalid_request", "invalid token request");
    if (
      !safeEqual(body.client_id, env.clientId) ||
      !safeEqual(body.client_secret, env.clientSecret)
    )
      return oauthError("invalid_client", "invalid client authentication", 401);
    const record = codes.get(body.code);
    codes.delete(body.code);
    if (
      !record ||
      record.expiresAt < Date.now() ||
      body.redirect_uri !== record.redirectUri ||
      !safeEqual(base64urlSha256(body.code_verifier), record.codeChallenge)
    )
      return oauthError("invalid_grant", "invalid authorization code");
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomValue();
    accessTokens.set(accessToken, { user: record.user, expiresAt: Date.now() + 300_000 });
    const signingKey = await importJWK(env.privateJwk, "ES256");
    const idToken = await new SignJWT({
      email: record.user.email,
      email_verified: record.user.emailVerified,
      name: record.user.name,
      nonce: record.nonce,
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: env.signingKid })
      .setIssuer(env.issuer)
      .setAudience(record.clientId)
      .setSubject(record.user.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signingKey);
    return c.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 300,
        scope: record.scope,
        id_token: idToken,
      },
      200,
      noStore,
    );
  });

  app.get("/userinfo", (c) => {
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const record = accessTokens.get(token);
    if (!record || record.expiresAt < Date.now())
      return oauthError("invalid_token", "invalid access token", 401);
    return c.json({
      sub: record.user.sub,
      email: record.user.email,
      email_verified: record.user.emailVerified,
      name: record.user.name,
    });
  });

  return app;
}
