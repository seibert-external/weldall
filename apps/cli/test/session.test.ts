import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ID_JAG_DRAFT,
  ID_JAG_TOKEN_TYPE,
  generateEs256KeyPair,
  issueAccessToken,
  issueIdJag,
  signEs256,
  type DpopKeyPair,
} from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { WELDALL_CLIENT_ID } from "../src/oauth/constants.js";

const WELDALL_ISSUER = "https://weldall.seibert.localdev";
const WELDALL_RESOURCE = `${WELDALL_ISSUER}/api`;
const EXPENSES_ISSUER = "https://expenses.seibert.localdev";
const EXPENSES_RESOURCE = `${EXPENSES_ISSUER}/api`;
const DOWNSTREAM_CLIENT_ID = "weldall-cli-at-expenses";
import { loopback } from "../src/oauth/loopback.js";
import {
  createPkce,
  refresh,
  tokenRequest,
  validateIdJagResponse,
  validateLoginResponse,
} from "../src/oauth/session.js";

const config: WeldallConfig = {
  issuer: WELDALL_ISSUER,
  resource: WELDALL_RESOURCE,
  authorize: `${WELDALL_ISSUER}/api/auth/oauth2/authorize`,
  token: `${WELDALL_ISSUER}/api/auth/oauth2/token`,
  revoke: `${WELDALL_ISSUER}/api/auth/oauth2/revoke`,
  jwks: `${WELDALL_ISSUER}/api/oauth/jwks`,
  cli: `${WELDALL_ISSUER}/api/me/cli`,
  grants: `${WELDALL_ISSUER}/api/me/grants`,
  scopes: `${WELDALL_ISSUER}/api/me/scopes`,
  skills: `${WELDALL_ISSUER}/api/me/skills`,
  userInfo: `${WELDALL_ISSUER}/api/auth/oauth2/userinfo`,
};

const jwksResponse = (...keys: Array<{ key: DpopKeyPair; kid: string }>) =>
  new Response(
    JSON.stringify({
      keys: keys.map(({ key, kid }) => ({
        ...key.publicJwk,
        kid,
        alg: "ES256",
        use: "sig",
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const stubJwks = (...keys: Array<{ key: DpopKeyPair; kid: string }>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jwksResponse(...keys)),
  );

afterEach(() => vi.unstubAllGlobals());

describe("native login", () => {
  it("never follows redirects while sending token credentials", async () => {
    const key = await generateEs256KeyPair();
    const fetcher = vi.fn(async () => Response.json({ error: "invalid_request" }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      tokenRequest(config, new URLSearchParams({ refresh_token: "secret" }), key),
    ).rejects.toThrow("invalid_request");
    expect(fetcher).toHaveBeenCalledWith(
      config.token,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("creates RFC7636 S256 values", () => {
    const p = createPkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("binds the callback to state and authorization-server issuer", async () => {
    const callback = await loopback("expected-state", "https://issuer.example", 2_000);
    const wrong = new URL(callback.redirectUri);
    wrong.searchParams.set("code", "wrong");
    wrong.searchParams.set("state", "expected-state");
    wrong.searchParams.set("iss", "https://other.example");
    expect((await fetch(wrong)).status).toBe(400);

    const valid = new URL(callback.redirectUri);
    valid.searchParams.set("code", "authorization-code");
    valid.searchParams.set("state", "expected-state");
    valid.searchParams.set("iss", "https://issuer.example");
    expect((await fetch(valid)).status).toBe(200);
    await expect(callback.code).resolves.toBe("authorization-code");
  });

  it("rejects missing, duplicate, ambiguous, or non-GET callback parameters", async () => {
    const callback = await loopback("expected-state", "https://issuer.example", 2_000);
    const base = new URL(callback.redirectUri);
    base.searchParams.set("code", "authorization-code");
    base.searchParams.set("state", "expected-state");
    base.searchParams.set("iss", "https://issuer.example");

    for (const mutate of [
      (url: URL) => url.searchParams.delete("state"),
      (url: URL) => url.searchParams.append("state", "expected-state"),
      (url: URL) => url.searchParams.append("iss", "https://issuer.example"),
      (url: URL) => url.searchParams.append("code", "second-code"),
      (url: URL) => url.searchParams.set("error", "access_denied"),
    ]) {
      const candidate = new URL(base);
      mutate(candidate);
      expect((await fetch(candidate)).status).toBe(400);
    }
    expect((await fetch(base, { method: "POST" })).status).toBe(400);
    expect((await fetch(base)).status).toBe(200);
    await expect(callback.code).resolves.toBe("authorization-code");
  });
});

describe("refresh rotation", () => {
  it("persists a structurally valid rotated token before JWKS validation", async () => {
    const device = await generateEs256KeyPair();
    const credentials = {
      version: 1 as const,
      issuer: config.issuer,
      privateJwk: device.privateJwk,
      publicJwk: device.publicJwk,
      refreshToken: "old-refresh-token",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          token_type: "DPoP",
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const persist = vi.fn(async () => undefined);

    await expect(refresh(config, credentials, persist)).rejects.toThrow(
      "Unable to load Weldall signing keys",
    );
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith({
      ...credentials,
      refreshToken: "new-refresh-token",
    });
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[1]!);
  });

  it("does not persist malformed refresh responses", async () => {
    const device = await generateEs256KeyPair();
    const credentials = {
      version: 1 as const,
      issuer: config.issuer,
      privateJwk: device.privateJwk,
      publicJwk: device.publicJwk,
      refreshToken: "old-refresh-token",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ token_type: "DPoP", access_token: "token", refresh_token: "" }),
      ),
    );
    const persist = vi.fn(async () => undefined);

    await expect(refresh(config, credentials, persist)).rejects.toThrow("invalid refresh response");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("CLI token validation", () => {
  it("validates login tokens and their device and nonce bindings", async () => {
    const issuer = await generateEs256KeyPair();
    const device = await generateEs256KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await signEs256(
      {
        iss: WELDALL_ISSUER,
        sub: "user",
        aud: [WELDALL_RESOURCE, `${WELDALL_ISSUER}/api/auth/oauth2/userinfo`],
        client_id: WELDALL_CLIENT_ID,
        azp: WELDALL_CLIENT_ID,
        scope: "weldall:scopes",
        cnf: { jkt: device.jkt },
        jti: "access-token",
        iat: now,
        exp: now + 600,
      },
      { kid: "weldall", privateJwk: issuer.privateJwk, typ: "at+jwt" },
    );
    const idToken = await signEs256(
      {
        iss: WELDALL_ISSUER,
        sub: "user",
        aud: WELDALL_CLIENT_ID,
        nonce: "expected-nonce",
        iat: now,
        exp: now + 300,
      },
      { kid: "weldall", privateJwk: issuer.privateJwk },
    );
    stubJwks({ key: issuer, kid: "weldall" });
    await expect(
      validateLoginResponse(
        config,
        {
          token_type: "DPoP",
          access_token: accessToken,
          refresh_token: "refresh-token",
          id_token: idToken,
        },
        device,
        "expected-nonce",
      ),
    ).resolves.toEqual({ refreshToken: "refresh-token", subject: "user" });
  });

  it("rejects an ID token with additional audiences", async () => {
    const issuer = await generateEs256KeyPair();
    const device = await generateEs256KeyPair();
    const accessToken = await issueAccessToken({
      issuer: WELDALL_ISSUER,
      subject: "user",
      email: "user@example.com",
      resource: WELDALL_RESOURCE,
      clientId: WELDALL_CLIENT_ID,
      scopes: ["weldall:scopes"],
      jkt: device.jkt,
      kid: "weldall",
      privateJwk: issuer.privateJwk,
    });
    const now = Math.floor(Date.now() / 1000);
    const idToken = await signEs256(
      {
        iss: WELDALL_ISSUER,
        sub: "user",
        aud: [WELDALL_CLIENT_ID, "attacker"],
        azp: WELDALL_CLIENT_ID,
        nonce: "expected-nonce",
        iat: now,
        exp: now + 300,
      },
      { kid: "weldall", privateJwk: issuer.privateJwk },
    );
    stubJwks({ key: issuer, kid: "weldall" });
    await expect(
      validateLoginResponse(
        config,
        {
          token_type: "DPoP",
          access_token: accessToken,
          refresh_token: "refresh-token",
          id_token: idToken,
        },
        device,
        "expected-nonce",
      ),
    ).rejects.toThrow("invalid ID-token binding");
  });

  it("validates an ID-JAG independently before forwarding it", async () => {
    const oldIssuerKey = await generateEs256KeyPair();
    const issuer = await generateEs256KeyPair();
    const device = await generateEs256KeyPair();
    const token = await issueIdJag({
      issuer: WELDALL_ISSUER,
      subject: "user",
      email: "user@example.com",
      audience: EXPENSES_ISSUER,
      clientId: DOWNSTREAM_CLIENT_ID,
      resource: EXPENSES_RESOURCE,
      scopes: ["expenses:read"],
      jkt: device.jkt,
      kid: "current",
      privateJwk: issuer.privateJwk,
    });
    stubJwks({ key: oldIssuerKey, kid: "old" }, { key: issuer, kid: "current" });
    await expect(
      validateIdJagResponse(
        config,
        {
          access_token: token,
          issued_token_type: ID_JAG_TOKEN_TYPE,
          token_type: "N_A",
          expires_in: 300,
          scope: "expenses:read",
        },
        device.publicJwk,
        {
          subject: "user",
          authorizationServer: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          clientId: DOWNSTREAM_CLIENT_ID,
          scopes: ["expenses:read"],
        },
      ),
    ).resolves.toBe(token);
  });

  it.each([
    ["additional audience", (_key: DpopKeyPair) => ({ aud: [EXPENSES_ISSUER, "attacker"] })],
    ["wrong resource", () => ({ resource: "https://attacker.example/api" })],
    ["wrong client", () => ({ client_id: "attacker" })],
    ["wrong subject", () => ({ sub: "other-user" })],
    ["empty device binding", () => ({ cnf: { jkt: "" } })],
    ["scope escalation", () => ({ scope: "expenses:read expenses:delete" })],
    ["invalid email", () => ({ email: "not-an-email" })],
    ["unverified email", () => ({ email_verified: false })],
  ])("rejects a returned ID-JAG with %s", async (_name, patch) => {
    const issuer = await generateEs256KeyPair();
    const device = await generateEs256KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signEs256(
      {
        iss: WELDALL_ISSUER,
        sub: "user",
        email: "user@example.com",
        email_verified: true,
        aud: EXPENSES_ISSUER,
        client_id: DOWNSTREAM_CLIENT_ID,
        resource: EXPENSES_RESOURCE,
        scope: "expenses:read",
        cnf: { jkt: device.jkt },
        jti: "id-jag",
        iat: now,
        exp: now + 300,
        "urn:weldall:id-jag-draft": ID_JAG_DRAFT,
        ...patch(device),
      },
      { kid: "weldall", privateJwk: issuer.privateJwk, typ: "oauth-id-jag+jwt" },
    );
    stubJwks({ key: issuer, kid: "weldall" });
    await expect(
      validateIdJagResponse(
        config,
        {
          access_token: token,
          issued_token_type: ID_JAG_TOKEN_TYPE,
          token_type: "N_A",
          expires_in: 300,
          scope: "expenses:read",
        },
        device.publicJwk,
        {
          subject: "user",
          authorizationServer: EXPENSES_ISSUER,
          resource: EXPENSES_RESOURCE,
          clientId: DOWNSTREAM_CLIENT_ID,
          scopes: ["expenses:read"],
        },
      ),
    ).rejects.toThrow();
  });
});
