import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDpopProof,
  generateEs256KeyPair,
  inMemory,
  issueAccessToken,
  type AuthContext,
  type DpopKeyPair,
  type WeldallOptions,
} from "../src/index.js";
import { initWeldall as initAstro } from "../src/astro.js";
import { initWeldall as initHono, type WeldallVariables } from "../src/hono.js";

let key: DpopKeyPair;
let device: DpopKeyPair;
let options: WeldallOptions;

beforeEach(async () => {
  key = await generateEs256KeyPair();
  device = await generateEs256KeyPair();
  options = {
    resource: "https://api.example/resource",
    publicOrigin: "https://api.example",
    clientId: "client",
    supportedScopes: ["read"],
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
  it("Hono registers routes, preserves errors, and stores typed auth", async () => {
    const weldall = initHono("https://weldall.example", options);
    const app = new Hono<{ Variables: WeldallVariables }>();
    weldall.registerRoutes(app);
    app.get("/private", weldall.protect({ scopes: ["read"] }), (c) =>
      c.json({ subject: weldall.getAuth(c).subject }),
    );
    expect((await app.request("/.well-known/oauth-protected-resource")).status).toBe(200);
    const response = await app.request("/private");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('DPoP error="invalid_token"');
    const success = await app.request(await authorizedRequest("https://api.example/private"));
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toEqual({ subject: "adapter-user" });
    await expectAdapterContract((request) => app.request(request));
  });

  it("Astro uses locals and always returns a Response", async () => {
    const weldall = initAstro("https://weldall.example", options);
    const locals: { weldallAuth?: AuthContext } = {};
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

  it("Next passes verified auth explicitly and preserves rejections", async () => {
    vi.doMock("server-only", () => ({}));
    const { initWeldall } = await import("../src/next.js");
    const weldall = initWeldall("https://weldall.example", options);
    const handler = weldall.withWeldall({ scopes: ["read"] }, async (_request, auth) =>
      Response.json({ subject: auth.subject }),
    );
    const response = await handler(new Request("https://api.example/private"), {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
    const success = await handler(await authorizedRequest("https://api.example/private"), {});
    expect(await success.json()).toEqual({ subject: "adapter-user" });
    await expectAdapterContract((request) => handler(request, {}));
  });
});
