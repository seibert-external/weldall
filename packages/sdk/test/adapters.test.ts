import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MACHINE_TOKEN_TYP,
  createDpopProof,
  generateEs256KeyPair,
  inMemory,
  issueAccessToken,
  signEs256,
  type AuthContext,
  type DpopKeyPair,
  type WeldallOptions,
} from "../src/index.js";
import { initWeldall as initAstro } from "../src/astro.js";
import { initWeldall as initHono, type WeldallVariables } from "../src/hono.js";

let key: DpopKeyPair;
let device: DpopKeyPair;
let issuerKey: DpopKeyPair;
let machineKey: DpopKeyPair;
let options: WeldallOptions;

beforeEach(async () => {
  key = await generateEs256KeyPair();
  device = await generateEs256KeyPair();
  issuerKey = await generateEs256KeyPair();
  machineKey = await generateEs256KeyPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://weldall.example/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://weldall.example",
          jwks_uri: "https://weldall.example/jwks",
        });
      if (url === "https://weldall.example/jwks")
        return Response.json({
          keys: [{ ...issuerKey.publicJwk, kid: "issuer", alg: "ES256", use: "sig" }],
        });
      return new Response(null, { status: 404 });
    }),
  );
  options = {
    resource: "https://api.example/resource",
    publicOrigin: "https://api.example",
    clientId: "client",
    supportedScopes: ["read", "other"],
    signingKey: { kid: "key", privateJwk: key.privateJwk, publicJwk: key.publicJwk },
    replayStore: inMemory({ suppressWarning: true }),
  };
});

const authorizedRequest = async (
  url: string,
  claims: { issuer?: string; resource?: string; scopes?: string[] } = {},
) => {
  const token = await issueAccessToken({
    issuer: claims.issuer ?? "https://api.example",
    subject: "adapter-user",
    email: "adapter@example.com",
    resource: claims.resource ?? "https://api.example/resource",
    clientId: "client",
    scopes: claims.scopes ?? ["read"],
    jkt: device.jkt,
    kid: "key",
    privateJwk: key.privateJwk,
  });
  const proof = await createDpopProof({ ...device, method: "GET", url, accessToken: token });
  return new Request(url, { headers: { authorization: `DPoP ${token}`, dpop: proof } });
};

const machineRequest = async (url: string) => {
  const now = Math.floor(Date.now() / 1_000);
  const token = await signEs256(
    {
      iss: "https://weldall.example",
      sub: "machine:automation",
      client_id: "automation",
      azp: "automation",
      aud: "https://api.example/resource",
      scope: "read",
      identity_type: "machine",
      token_type: "machine",
      cnf: { jkt: machineKey.jkt },
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    },
    { kid: "issuer", privateJwk: issuerKey.privateJwk, typ: MACHINE_TOKEN_TYP },
  );
  const proof = await createDpopProof({ ...machineKey, method: "GET", url, accessToken: token });
  return new Request(url, { headers: { authorization: `DPoP ${token}`, dpop: proof } });
};

const browserOrigin = "https://app.example";
const browserPreflight = (url: string, method = "GET") =>
  new Request(url, {
    method: "OPTIONS",
    headers: {
      origin: browserOrigin,
      "access-control-request-method": method,
      "access-control-request-headers":
        "Authorization, DPoP, Content-Type, X-Request-Id, X-Correlation-Id",
    },
  });

const expectAdapterContract = async (protect: (request: Request) => Promise<Response>) => {
  const url = "https://api.example/private";
  expect((await protect(await authorizedRequest(url))).status).toBe(200);
  expect(
    (await protect(await authorizedRequest(url, { issuer: "https://wrong.example" }))).status,
  ).toBe(401);
  expect(
    (await protect(await authorizedRequest(url, { resource: "https://wrong.example/resource" })))
      .status,
  ).toBe(401);
  expect((await protect(await authorizedRequest(url, { scopes: ["other"] }))).status).toBe(403);
  const replay = await authorizedRequest(url);
  expect((await protect(replay)).status).toBe(200);
  expect((await protect(replay)).status).toBe(401);
};

describe("framework adapters", () => {
  it("Hono registers routes, preserves errors, stores typed auth, and handles CORS", async () => {
    const replayStore = inMemory({ suppressWarning: true });
    const replayConsume = vi.fn((key: string, expiresAt: Date) =>
      replayStore.consume(key, expiresAt),
    );
    options = {
      ...options,
      replayStore: { consume: replayConsume },
      allowedOrigins: [browserOrigin],
      allowedMethods: ["GET", "POST"],
    };
    const weldall = initHono("https://weldall.example", options);
    const app = new Hono<{ Variables: WeldallVariables }>();
    weldall.registerRoutes(app);
    app.options("/private", weldall.preflight(["GET"]));
    app.get("/private", weldall.protect({ scopes: ["read"] }), (c) => {
      const auth = weldall.getAuth(c);
      return c.json({
        subject: auth.subject,
        email: auth.identity.type === "user" ? auth.identity.email : null,
      });
    });
    expect((await app.request("/.well-known/oauth-protected-resource")).status).toBe(200);
    const originlessOptions = await app.request("/private", { method: "OPTIONS" });
    expect(originlessOptions.status).toBe(405);
    const preflight = await app.request(browserPreflight("https://api.example/private"));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(browserOrigin);
    expect(replayConsume).not.toHaveBeenCalled();
    expect(
      (await app.request(browserPreflight("https://api.example/private", "DELETE"))).status,
    ).toBe(403);
    expect((await app.request(browserPreflight("https://api.example/not-registered"))).status).toBe(
      404,
    );
    expect(
      (await app.request(browserPreflight("https://api.example/oauth/token", "GET"))).status,
    ).toBe(403);
    const corsError = await app.request(
      new Request("https://api.example/private", { headers: { origin: browserOrigin } }),
    );
    expect(corsError.status).toBe(401);
    expect(corsError.headers.get("access-control-allow-origin")).toBe(browserOrigin);
    const response = await app.request("/private");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('DPoP error="invalid_token"');
    const success = await app.request(await authorizedRequest("https://api.example/private"));
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toEqual({
      subject: "adapter-user",
      email: "adapter@example.com",
    });
    const machine = await app.request(await machineRequest("https://api.example/private"));
    await expect(machine.json()).resolves.toEqual({
      subject: "machine:automation",
      email: null,
    });
    await expectAdapterContract((request) => app.request(request));
  });

  it("Astro uses locals, returns Responses, and handles CORS", async () => {
    const replayStore = inMemory({ suppressWarning: true });
    const replayConsume = vi.fn((key: string, expiresAt: Date) =>
      replayStore.consume(key, expiresAt),
    );
    options = {
      ...options,
      replayStore: { consume: replayConsume },
      allowedOrigins: [browserOrigin],
      allowedMethods: ["GET", "POST"],
    };
    const weldall = initAstro("https://weldall.example", options);
    const locals: { weldallAuth?: AuthContext } = {};
    const preflight = await weldall.protect({}, ["GET"])(
      { request: browserPreflight("https://api.example/private"), locals },
      () => Response.json({ shouldNotRun: true }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(browserOrigin);
    expect(replayConsume).not.toHaveBeenCalled();
    expect(
      (
        await weldall.protect({}, ["GET"])(
          {
            request: browserPreflight("https://api.example/private", "DELETE"),
            locals: {},
          },
          () => Response.json({ shouldNotRun: true }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await weldall.preflight(
          ["GET"],
          "/private",
        )({
          request: browserPreflight("https://api.example/not-registered"),
          locals: {},
        })
      ).status,
    ).toBe(404);
    const corsError = await weldall.protect()(
      {
        request: new Request("https://api.example/private", {
          headers: { origin: browserOrigin },
        }),
        locals,
      },
      () => Response.json({ shouldNotRun: true }),
    );
    expect(corsError.status).toBe(401);
    expect(corsError.headers.get("access-control-allow-origin")).toBe(browserOrigin);
    const response = await weldall.protect()(
      { request: new Request("https://api.example/private"), locals },
      () => Response.json({ reached: true }),
    );
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(401);
    expect(locals).toEqual({});
    const success = await weldall.protect({ scopes: ["read"] })(
      { request: await authorizedRequest("https://api.example/private"), locals },
      () => Response.json({ subject: weldall.getAuth({ locals }).subject }),
    );
    expect(await success.json()).toEqual({ subject: "adapter-user" });
    const machineLocals: { weldallAuth?: AuthContext } = {};
    const machine = await weldall.protect({ scopes: ["read"] })(
      { request: await machineRequest("https://api.example/private"), locals: machineLocals },
      () =>
        Response.json({ identityType: weldall.getAuth({ locals: machineLocals }).identityType }),
    );
    expect(await machine.json()).toEqual({ identityType: "machine" });
    await expectAdapterContract((request) =>
      weldall.protect({ scopes: ["read"] })({ request, locals: {} }, () =>
        Response.json({ protected: true }),
      ),
    );
    await expect(
      weldall.handlers.jwks({
        request: new Request("https://api.example/.well-known/jwks.json"),
        locals,
      }),
    ).resolves.toBeInstanceOf(Response);
  });

  it("Next passes verified auth explicitly, preserves rejections, and handles CORS", async () => {
    vi.doMock("server-only", () => ({}));
    const { initWeldall } = await import("../src/next.js");
    const replayStore = inMemory({ suppressWarning: true });
    const replayConsume = vi.fn((key: string, expiresAt: Date) =>
      replayStore.consume(key, expiresAt),
    );
    options = {
      ...options,
      replayStore: { consume: replayConsume },
      allowedOrigins: [browserOrigin],
      allowedMethods: ["GET", "POST"],
    };
    const weldall = initWeldall("https://weldall.example", options);
    const handler = weldall.withWeldall({ scopes: ["read"] }, async (_request, auth) =>
      Response.json({ subject: auth.subject }),
    );
    const optionsHandler = weldall.preflight(["GET"], "/private");
    const preflight = await optionsHandler(browserPreflight("https://api.example/private"), {});
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(browserOrigin);
    expect(replayConsume).not.toHaveBeenCalled();
    expect(
      (await optionsHandler(browserPreflight("https://api.example/private", "DELETE"), {})).status,
    ).toBe(403);
    expect(
      (await optionsHandler(browserPreflight("https://api.example/not-registered"), {})).status,
    ).toBe(404);
    expect((await handler(browserPreflight("https://api.example/private"), {})).status).toBe(405);
    const corsError = await handler(
      new Request("https://api.example/private", { headers: { origin: browserOrigin } }),
      {},
    );
    expect(corsError.status).toBe(401);
    expect(corsError.headers.get("access-control-allow-origin")).toBe(browserOrigin);
    const response = await handler(new Request("https://api.example/private"), {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
    const success = await handler(await authorizedRequest("https://api.example/private"), {});
    expect(await success.json()).toEqual({ subject: "adapter-user" });
    const machine = await handler(await machineRequest("https://api.example/private"), {});
    expect(await machine.json()).toEqual({ subject: "machine:automation" });
    await expectAdapterContract((request) => handler(request, {}));
  });
});
