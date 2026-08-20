import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculateJwkThumbprint, decodeJwt } from "jose";
import {
  JWT_DPOP_GRANT,
  WeldallAuthError,
  consumeReplay,
  createDpopProof,
  generateEs256KeyPair,
  inMemory,
  initWeldall,
  isSha256JwkThumbprint,
  issueAccessToken,
  issueIdJag as issueSdkIdJag,
  oauthErrorResponse,
  parseSkillCatalog,
  signEs256,
  verifyAccessToken,
  verifyIdJag,
  type DpopKeyPair,
} from "../src/index.js";

const host = "https://weldall.example";
const origin = "https://expenses.example";
const resource = `${origin}/api`;
const clientId = "weldall-cli-at-expenses";
let weldallKey: DpopKeyPair;
let localKey: DpopKeyPair;
let deviceKey: DpopKeyPair;
let discoveredKey: DpopKeyPair;
let discoveredKid: string;
let fetchCalls: string[];

const issueIdJag = (input: Omit<Parameters<typeof issueSdkIdJag>[0], "email">) =>
  issueSdkIdJag({ ...input, email: "user@example.com" });

it.each([[""], ["x".repeat(41)], Array.from({ length: 21 }, (_, index) => `tag-${index}`)])(
  "rejects invalid published skill tags",
  (tags) => {
    expect(() =>
      parseSkillCatalog({
        schemaVersion: 1,
        resource,
        skills: [
          {
            id: "review",
            title: "Review expenses",
            requiredScopes: [],
            visibility: "DEFAULT",
            content: "# Review expenses",
            meta: { tags },
          },
        ],
      }),
    ).toThrow(/meta/);
  },
);

beforeEach(async () => {
  weldallKey = await generateEs256KeyPair();
  localKey = await generateEs256KeyPair();
  deviceKey = await generateEs256KeyPair();
  discoveredKey = weldallKey;
  discoveredKid = "w1";
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);
      if (url === `${host}/.well-known/oauth-authorization-server`)
        return Response.json({ issuer: host, jwks_uri: `${host}/jwks` });
      if (url === `${host}/jwks`)
        return Response.json({
          keys: [
            {
              ...discoveredKey.publicJwk,
              kid: discoveredKid,
              alg: "ES256",
              use: "sig",
            },
          ],
        });
      return new Response(null, { status: 404 });
    }),
  );
});

const sdk = () =>
  initWeldall(host, {
    resource,
    publicOrigin: origin,
    clientId,
    supportedScopes: ["read", "write", "admin"],
    signingKey: {
      kid: "local",
      privateJwk: localKey.privateJwk,
      publicJwk: localKey.publicJwk,
    },
    replayStore: inMemory({ suppressWarning: true }),
  });

const assertion = (key = weldallKey, kid = "w1", scopes = ["read", "write"]) =>
  issueIdJag({
    issuer: host,
    subject: "user-1",
    audience: origin,
    clientId,
    resource,
    scopes,
    jkt: deviceKey.jkt,
    kid,
    privateJwk: key.privateJwk,
  });

async function exchange(instance = sdk(), jag = assertion()) {
  const proof = await createDpopProof({
    ...deviceKey,
    method: "POST",
    url: `${origin}/oauth/token`,
  });
  const response = await instance.handlers.token(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        dpop: proof,
      },
      body: new URLSearchParams({
        grant_type: JWT_DPOP_GRANT,
        assertion: await jag,
      }),
    }),
  );
  const body = (await response.clone().json()) as {
    access_token?: string;
    error?: string;
  };
  return { instance, response, body };
}

async function protectedRequest(token: string, url = `${origin}/api/expenses`, method = "GET") {
  const proof = await createDpopProof({
    ...deviceKey,
    method,
    url,
    accessToken: token,
  });
  return new Request(url, {
    method,
    headers: { authorization: `DPoP ${token}`, dpop: proof },
  });
}

describe("configuration and metadata", () => {
  it("fails invalid local configuration synchronously", () => {
    expect(() => initWeldall("http://remote.example", {} as never)).toThrow("HTTPS");
    expect(() =>
      initWeldall(host, {
        resource,
        publicOrigin: `${origin}/path`,
        clientId,
        supportedScopes: [],
        signingKey: {} as never,
        replayStore: "disabled",
      }),
    ).toThrow("origin");
    expect(() =>
      initWeldall(host, {
        resource,
        publicOrigin: origin,
        clientId,
        supportedScopes: [],
        signingKey: {
          kid: "bad",
          privateJwk: localKey.privateJwk,
          publicJwk: weldallKey.publicJwk,
        },
        replayStore: "disabled",
      }),
    ).toThrow("signing key");
    expect(() =>
      initWeldall(host, {
        resource,
        publicOrigin: origin,
        clientId,
        supportedScopes: [],
        signingKey: {
          kid: "local",
          privateJwk: localKey.privateJwk,
          publicJwk: localKey.publicJwk,
        },
        replayStore: "disabled",
        discoveryTimeoutMs: 0,
      }),
    ).toThrow("discoveryTimeoutMs");
    expect(() => sdk()).not.toThrow();
  });

  it("warns once for process-local replay storage unless suppressed", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    inMemory();
    inMemory();
    inMemory({ suppressWarning: true });
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("preloads only on ready and publishes resource metadata/JWKS", async () => {
    const instance = sdk();
    expect(fetchCalls).toEqual([]);
    await instance.ready();
    expect(fetchCalls).toEqual([`${host}/.well-known/oauth-authorization-server`, `${host}/jwks`]);
    await expect(instance.handlers.protectedResourceMetadata()).resolves.toMatchObject({
      status: 200,
    });
    const authorizationServerMetadata = (await (
      await instance.handlers.authorizationServerMetadata()
    ).json()) as Record<string, unknown>;
    expect(authorizationServerMetadata).toMatchObject({
      response_types_supported: [],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const jwks = (await (await instance.handlers.jwks()).json()) as {
      keys: { kid: string }[];
    };
    expect(jwks.keys.map(({ kid }) => kid)).toEqual(["local"]);
  });

  it("publishes and protects a skill catalog with a replay-safe service assertion", async () => {
    const instance = initWeldall(host, {
      resource,
      publicOrigin: origin,
      clientId,
      supportedScopes: ["expenses:read"],
      signingKey: {
        kid: "local",
        privateJwk: localKey.privateJwk,
        publicJwk: localKey.publicJwk,
      },
      replayStore: inMemory({ suppressWarning: true }),
      skills: {
        items: [
          {
            id: "review",
            title: "Review expenses",
            requiredScopes: ["expenses:read"],
            visibility: "DEFAULT",
            content: "# Review expenses",
            meta: { tags: ["finance", "review"], owner: "user-123" },
            lastUpdatedAt: "not restricted to a timestamp",
          },
        ],
      },
    });
    const metadata = (await (await instance.handlers.protectedResourceMetadata()).json()) as Record<
      string,
      unknown
    >;
    expect(metadata.weldall_skills_endpoint).toBe(`${origin}/.well-known/weldall-skills`);
    const now = Math.floor(Date.now() / 1_000);
    const token = await signEs256(
      {
        iss: host,
        sub: host,
        aud: `${origin}/.well-known/weldall-skills`,
        resource,
        purpose: "skills:read",
        iat: now,
        exp: now + 60,
        jti: "skills-test",
      },
      {
        kid: "w1",
        privateJwk: weldallKey.privateJwk,
        typ: "weldall-skills+jwt",
      },
    );
    const request = () =>
      new Request(`${origin}/.well-known/weldall-skills`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const response = await instance.handlers.skills(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      resource,
      skills: [
        {
          id: "review",
          visibility: "DEFAULT",
          meta: { tags: ["finance", "review"], owner: "user-123" },
          lastUpdatedAt: "not restricted to a timestamp",
        },
      ],
    });
    await expect(instance.handlers.skills(request())).resolves.toMatchObject({
      status: 401,
    });
  });

  it("maps unknown endpoint failures to server errors", async () => {
    const response = oauthErrorResponse(new Error("database unavailable"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "server_error",
      error_description: "server error",
    });
  });

  it("marks replay rejection structurally instead of relying on message text", async () => {
    await expect(
      consumeReplay(
        { consume: async () => false },
        "dpop",
        "duplicate",
        new Date(Date.now() + 60_000),
        { code: "invalid_dpop_proof", message: "already seen" },
      ),
    ).rejects.toMatchObject({ reason: "replay_detected" });
  });

  it("matches the official RFC 7638 JWK thumbprint vector", async () => {
    const thumbprint = await calculateJwkThumbprint(
      {
        kty: "RSA",
        n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
        e: "AQAB",
        alg: "RS256",
        kid: "2011-04-29",
      },
      "sha256",
    );
    expect(thumbprint).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
    expect(isSha256JwkThumbprint(thumbprint)).toBe(true);
  });
});

describe("exchange and verification", () => {
  it("exchanges a pinned ID-JAG and verifies local tokens without Weldall network", async () => {
    const { instance, response, body } = await exchange();
    expect(response.status).toBe(200);
    expect(decodeJwt(body.access_token!)).toMatchObject({
      iss: origin,
      aud: resource,
      sub: "user-1",
      email: "user@example.com",
      email_verified: true,
      scope: "read write",
      cnf: { jkt: deviceKey.jkt },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const auth = await instance.verify(await protectedRequest(body.access_token!), {
      scopes: ["read"],
      anyScopes: ["write", "admin"],
    });
    expect(auth).toMatchObject({
      identityType: "user",
      subject: "user-1",
      email: "user@example.com",
      emailVerified: true,
      identity: {
        type: "user",
        subject: "user-1",
        email: "user@example.com",
        emailVerified: true,
      },
      scopes: ["read", "write"],
    });
  });

  it("rejects locally signed tokens with the wrong issuer or audience", async () => {
    const instance = sdk();
    for (const claims of [
      { issuer: "https://wrong.example", resource },
      { issuer: origin, resource: "https://wrong.example/api" },
    ]) {
      const token = await issueAccessToken({
        ...claims,
        subject: "user-1",
        email: "user@example.com",
        clientId,
        scopes: ["read"],
        jkt: deviceKey.jkt,
        kid: "local",
        privateJwk: localKey.privateJwk,
      });
      await expect(instance.verify(await protectedRequest(token))).rejects.toMatchObject({
        code: "invalid_token",
        status: 401,
      });
      await expect(
        verifyAccessToken(token, {
          issuer: origin,
          resource,
          clientId,
          kid: "local",
          publicJwk: localKey.publicJwk,
        }),
      ).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    }
  });

  it.each([
    ["missing email", { email: undefined }],
    ["invalid email", { email: "not-an-email" }],
    ["unverified email", { email_verified: false }],
  ])("rejects an access token with %s", async (_name, patch) => {
    const valid = decodeJwt(
      await issueAccessToken({
        issuer: origin,
        subject: "user-1",
        email: "user@example.com",
        resource,
        clientId,
        scopes: ["read"],
        jkt: deviceKey.jkt,
        kid: "local",
        privateJwk: localKey.privateJwk,
      }),
    );
    const token = await signEs256(
      { ...valid, ...patch },
      { kid: "local", privateJwk: localKey.privateJwk, typ: "at+jwt" },
    );
    await expect(sdk().verify(await protectedRequest(token))).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
    await expect(
      verifyAccessToken(token, {
        issuer: origin,
        resource,
        clientId,
        kid: "local",
        publicJwk: localKey.publicJwk,
      }),
    ).rejects.toMatchObject({ code: "invalid_token", status: 401 });
  });

  it("returns consistent 401/403 responses and detects proof replay", async () => {
    const { instance, body } = await exchange();
    const request = await protectedRequest(body.access_token!);
    await expect(instance.verify(request, { scopes: ["admin"] })).rejects.toMatchObject({
      code: "insufficient_scope",
      status: 403,
    });
    const malformedProof = await instance.verifyNoThrow(
      new Request(`${origin}/api/expenses`, {
        headers: {
          authorization: `DPoP ${body.access_token!}`,
          dpop: "not-a-proof",
        },
      }),
      { scopes: ["admin"] },
    );
    expect(malformedProof.ok).toBe(false);
    if (!malformedProof.ok) {
      expect(malformedProof.response.status).toBe(401);
      expect(malformedProof.error.code).toBe("invalid_dpop_proof");
    }
    const first = await protectedRequest(body.access_token!);
    const proof = first.headers.get("dpop")!;
    await instance.verify(first);
    const replay = await instance.verifyNoThrow(
      new Request(first.url, {
        headers: {
          authorization: first.headers.get("authorization")!,
          dpop: proof,
        },
      }),
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.response.status).toBe(401);
      expect(replay.response.headers.get("www-authenticate")).toContain("invalid_dpop_proof");
    }
  });

  it("does not let a network-path request escape the configured public origin", async () => {
    const { instance, body } = await exchange();
    const token = body.access_token!;
    const proof = await createDpopProof({
      ...deviceKey,
      method: "GET",
      url: "https://evil.example/path",
      accessToken: token,
    });
    await expect(
      instance.verify(
        new Request(`${origin}//evil.example/path`, {
          headers: { authorization: `DPoP ${token}`, dpop: proof },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_dpop_proof", status: 401 });
  });

  it("pins ID-JAG audience, client, resource, and supported scopes", async () => {
    const invalidAssertions = [
      issueIdJag({
        issuer: host,
        subject: "user-1",
        audience: "https://wrong.example",
        clientId,
        resource,
        scopes: ["read"],
        jkt: deviceKey.jkt,
        kid: "w1",
        privateJwk: weldallKey.privateJwk,
      }),
      issueIdJag({
        issuer: host,
        subject: "user-1",
        audience: origin,
        clientId: "wrong",
        resource,
        scopes: ["read"],
        jkt: deviceKey.jkt,
        kid: "w1",
        privateJwk: weldallKey.privateJwk,
      }),
      issueIdJag({
        issuer: host,
        subject: "user-1",
        audience: origin,
        clientId,
        resource: "https://wrong.example/api",
        scopes: ["read"],
        jkt: deviceKey.jkt,
        kid: "w1",
        privateJwk: weldallKey.privateJwk,
      }),
      issueIdJag({
        issuer: host,
        subject: "user-1",
        audience: origin,
        clientId,
        resource,
        scopes: ["unknown"],
        jkt: deviceKey.jkt,
        kid: "w1",
        privateJwk: weldallKey.privateJwk,
      }),
    ];
    for (const jag of invalidAssertions)
      expect((await exchange(sdk(), jag)).response.status).toBe(400);
  });

  it.each([
    ["missing email", { email: undefined }],
    ["invalid email", { email: "not-an-email" }],
    ["unverified email", { email_verified: false }],
  ])("rejects an ID-JAG with %s", async (_name, patch) => {
    const valid = decodeJwt(await assertion());
    const jag = await signEs256(
      { ...valid, ...patch },
      { kid: "w1", privateJwk: weldallKey.privateJwk, typ: "oauth-id-jag+jwt" },
    );
    await expect(
      verifyIdJag(jag, {
        issuer: host,
        audience: origin,
        resource,
        clientId,
        kid: "w1",
        publicJwk: weldallKey.publicJwk,
        allowedScopes: ["read", "write"],
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect((await exchange(sdk(), Promise.resolve(jag))).response.status).toBe(400);
  });

  it("atomically consumes ID-JAGs and enforces strict token forms", async () => {
    const instance = sdk();
    const jag = await assertion();
    const make = async () => exchange(instance, Promise.resolve(jag));
    const results = await Promise.all([make(), make()]);
    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 400]);
    const bad = await instance.handlers.token(
      new Request(`${origin}/oauth/token`, { method: "GET" }),
    );
    expect(bad.status).toBe(400);
  });

  it("refreshes JWKS once for an unknown rotated kid", async () => {
    const instance = sdk();
    await instance.ready();
    const rotated = await generateEs256KeyPair();
    discoveredKey = rotated;
    discoveredKid = "w2";
    const result = await exchange(instance, assertion(rotated, "w2", ["read"]));
    expect(result.response.status).toBe(200);
    expect(fetchCalls.filter((url) => url === `${host}/jwks`)).toHaveLength(2);
  });

  it("refreshes JWKS when a rotated key reuses the kid", async () => {
    const instance = sdk();
    await instance.ready();
    const rotated = await generateEs256KeyPair();
    discoveredKey = rotated;
    const result = await exchange(instance, assertion(rotated, "w1", ["read"]));
    expect(result.response.status).toBe(200);
    expect(fetchCalls.filter((url) => url === `${host}/jwks`)).toHaveLength(2);
  });

  it("shares a same-kid rotation refresh across concurrent exchanges", async () => {
    const instance = sdk();
    await instance.ready();
    const rotated = await generateEs256KeyPair();
    discoveredKey = rotated;
    const results = await Promise.all([
      exchange(instance, assertion(rotated, "w1", ["read"])),
      exchange(instance, assertion(rotated, "w1", ["read"])),
    ]);
    expect(results.map(({ response }) => response.status)).toEqual([200, 200]);
    expect(fetchCalls.filter((url) => url === `${host}/jwks`)).toHaveLength(2);
  });

  it("stops trusting a removed Weldall key after the JWKS cache expires", async () => {
    const instance = sdk();
    await instance.ready();
    const removedKey = weldallKey;
    discoveredKey = await generateEs256KeyPair();
    discoveredKid = "w2";
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    const result = await exchange(instance, assertion(removedKey, "w1", ["read"]));
    nowSpy.mockRestore();
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
    expect(fetchCalls.filter((url) => url === `${host}/jwks`).length).toBeGreaterThanOrEqual(2);
  });

  it("fails closed when replay storage fails", async () => {
    const instance = initWeldall(host, {
      resource,
      publicOrigin: origin,
      clientId,
      supportedScopes: ["read"],
      signingKey: {
        kid: "local",
        privateJwk: localKey.privateJwk,
        publicJwk: localKey.publicJwk,
      },
      replayStore: {
        consume: async () => {
          throw new Error("redis unavailable");
        },
      },
    });
    const result = await exchange(instance, assertion(weldallKey, "w1", ["read"]));
    expect(result.response.status).toBe(503);
    expect(result.body.error).toBe("temporarily_unavailable");
  });
});

describe("discovery and signing hardening", () => {
  it.each([
    { issuer: "https://evil.example", jwks_uri: `${host}/jwks` },
    { issuer: host, jwks_uri: "https://evil.example/jwks" },
    { issuer: host, jwks_uri: `${host}/jwks?redirect=evil` },
  ])("rejects unsafe discovery metadata: $jwks_uri", async (metadata) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(metadata)),
    );
    await expect(sdk().ready()).rejects.toBeInstanceOf(WeldallAuthError);
  });

  it("accepts and validates a KMS-style async signer", async () => {
    const provider = {
      current: async () => ({
        kid: "kms",
        publicJwk: localKey.publicJwk,
        sign: (payload: Parameters<typeof signEs256>[0], header: { kid: string; typ: string }) =>
          signEs256(payload, {
            kid: header.kid,
            privateJwk: localKey.privateJwk,
            typ: header.typ,
          }),
      }),
      jwks: async () => [{ ...localKey.publicJwk, kid: "kms" }],
    };
    const instance = initWeldall(host, {
      resource,
      publicOrigin: origin,
      clientId,
      supportedScopes: ["read"],
      signingKey: provider,
      replayStore: inMemory({ suppressWarning: true }),
    });
    expect((await exchange(instance, assertion(weldallKey, "w1", ["read"]))).response.status).toBe(
      200,
    );
  });

  it.each([
    async () => "not-a-jwt",
    async (payload: Parameters<typeof signEs256>[0], header: { kid: string; typ: string }) => {
      payload.scope = "admin";
      return signEs256(payload, {
        kid: header.kid,
        privateJwk: localKey.privateJwk,
        typ: header.typ,
      });
    },
  ])("rejects invalid or payload-mutating async signer output", async (sign) => {
    const provider = {
      current: async () => ({
        kid: "kms",
        publicJwk: localKey.publicJwk,
        sign,
      }),
      jwks: async () => [{ ...localKey.publicJwk, kid: "kms" }],
    };
    const instance = initWeldall(host, {
      resource,
      publicOrigin: origin,
      clientId,
      supportedScopes: ["read"],
      signingKey: provider,
      replayStore: inMemory({ suppressWarning: true }),
    });
    const result = await exchange(instance, assertion(weldallKey, "w1", ["read"]));
    expect(result.response.status).toBe(500);
    expect(result.body.error).toBe("server_error");
  });
});
