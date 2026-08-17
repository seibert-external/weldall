import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair, initWeldall } from "../src/index.js";

const appOrigin = "https://app.example";
let signing: Awaited<ReturnType<typeof generateEs256KeyPair>>;

beforeEach(async () => {
  signing = await generateEs256KeyPair();
});

const create = (overrides: Record<string, unknown> = {}) =>
  initWeldall("https://weldall.example", {
    resource: "https://api.example/resource",
    publicOrigin: "https://api.example",
    clientId: "client",
    supportedScopes: ["read"],
    signingKey: { kid: "key", privateJwk: signing.privateJwk, publicJwk: signing.publicJwk },
    replayStore: { consume: vi.fn(async () => true) },
    allowedOrigins: [appOrigin],
    allowedMethods: ["GET", "POST"],
    ...overrides,
  });

const preflight = (
  origin = appOrigin,
  method = "POST",
  headers = "Authorization, DPoP, Content-Type, X-Request-Id, X-Correlation-Id",
) =>
  new Request("https://api.example/oauth/token", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": headers,
    },
  });

describe("resource browser CORS", () => {
  it("answers preflight before the token handler or replay store", async () => {
    const replay = { consume: vi.fn(async () => true) };
    const weldall = create({ replayStore: replay });
    const response = await weldall.handlers.token(preflight());
    expect(response.status).toBe(204);
    expect(replay.consume).not.toHaveBeenCalled();
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization, DPoP, Content-Type, X-Request-Id, X-Correlation-Id",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "WWW-Authenticate, DPoP-Nonce",
    );
    expect(response.headers.get("vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
  });

  it.each([
    ["wildcard", "*", "POST", "Authorization"],
    ["missing", "", "POST", "Authorization"],
    ["malformed", "https://app.example/path", "POST", "Authorization"],
    ["method", appOrigin, "DELETE", "Authorization"],
    ["header", appOrigin, "POST", "X-Unsafe"],
  ])(
    "rejects %s preflight without reflecting an origin",
    async (_label, origin, method, headers) => {
      const weldall = create();
      const request = preflight(origin || appOrigin, method, headers);
      if (!origin) request.headers.delete("origin");
      const response = await weldall.handlers.token(request);
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("vary")).toContain("Origin");
    },
  );

  it("binds raw Fetch preflight to exact methods and paths", () => {
    const weldall = create();
    expect(weldall.preflight(preflight(appOrigin, "GET"), ["POST"], "/oauth/token").status).toBe(
      403,
    );
    expect(
      weldall.preflight(
        new Request("https://api.example/not-registered", {
          method: "OPTIONS",
          headers: {
            origin: appOrigin,
            "access-control-request-method": "GET",
          },
        }),
        ["GET"],
        "/private",
      ).status,
    ).toBe(404);
  });

  it("decorates success and OAuth errors while leaving originless callers unchanged", async () => {
    const weldall = create();
    const error = await weldall.handlers.token(
      new Request("https://api.example/oauth/token", {
        method: "POST",
        headers: { origin: appOrigin, "content-type": "application/json" },
      }),
    );
    expect(error.status).toBe(400);
    expect(error.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(error.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");

    const response = new Response("ok", { headers: { "x-test": "yes" } });
    const decorated = await weldall.withBrowserCors(
      new Request("https://api.example/private", { headers: { origin: appOrigin } }),
      ["GET"],
      () => response,
    );
    expect(decorated.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(decorated.headers.get("x-test")).toBe("yes");

    const originless = new Response("cli");
    expect(
      await weldall.withBrowserCors(
        new Request("https://api.example/private"),
        ["GET"],
        () => originless,
      ),
    ).toBe(originless);
    const originlessOptions = new Response("cli-options");
    expect(
      await weldall.withBrowserCors(
        new Request("https://api.example/private", { method: "OPTIONS" }),
        ["GET"],
        () => originlessOptions,
      ),
    ).toBe(originlessOptions);
  });

  it("uses publicOrigin as the exact default and validates configuration", async () => {
    const weldall = create({ allowedOrigins: undefined });
    const sameOrigin = await weldall.handlers.authorizationServerMetadata(
      new Request("https://api.example/.well-known/oauth-authorization-server", {
        headers: { origin: "https://api.example" },
      }),
    );
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBe("https://api.example");
    const disallowedMethod = await weldall.handlers.authorizationServerMetadata(
      new Request("https://api.example/.well-known/oauth-authorization-server", {
        method: "POST",
        headers: { origin: "https://api.example" },
      }),
    );
    expect(disallowedMethod.status).toBe(403);
    const other = await weldall.handlers.authorizationServerMetadata(
      new Request("https://api.example/.well-known/oauth-authorization-server", {
        headers: { origin: appOrigin },
      }),
    );
    expect(other.status).toBe(403);
    expect(() => create({ allowedOrigins: ["*"] })).toThrow("absolute URL");
    expect(() => create({ allowedOrigins: [appOrigin, appOrigin] })).toThrow("unique");
  });
});
