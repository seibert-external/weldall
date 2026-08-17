import { describe, expect, it, vi } from "vitest";

Object.assign(process.env, {
  BETTER_AUTH_SECRET: "browser-cors-routes-test-secret-at-least-32-characters",
  OAUTH_PROXY_SECRET: "browser-cors-routes-proxy-secret-at-least-32-characters",
  WELDALL_SIGNING_KID: "browser-cors-routes-test",
});

vi.mock("../src/server/auth/auth", () => ({
  auth: { handler: vi.fn(async () => new Response(null, { status: 401 })) },
}));

vi.mock("@better-auth/oauth-provider", () => ({
  oauthProviderAuthServerMetadata: vi.fn(() => async () => Response.json({})),
  oauthProviderOpenIdConfigMetadata: vi.fn(() => async () => Response.json({})),
}));

vi.mock("../src/server/oauth/browser-resources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/oauth/browser-resources")>()),
  isCurrentEnabledBrowserOrigin: vi.fn(async (origin: string) => origin === "https://spa.example"),
}));

vi.mock("../src/server/oauth/browser-connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/oauth/browser-connections")>()),
  auditBrowserConnectionFailure: vi.fn(async () => undefined),
  consumeBrowserEntranceRateLimit: vi.fn(async () => undefined),
}));

type RouteModule = Record<
  "GET" | "POST" | "OPTIONS",
  ((request: Request) => Promise<Response>) | undefined
>;

const browserRoutes = [
  [
    "/.well-known/oauth-authorization-server",
    "GET",
    () => import("../src/app/.well-known/oauth-authorization-server/route"),
  ],
  [
    "/.well-known/oauth-protected-resource/api",
    "GET",
    () => import("../src/app/.well-known/oauth-protected-resource/api/route"),
  ],
  [
    "/.well-known/openid-configuration",
    "GET",
    () => import("../src/app/.well-known/openid-configuration/route"),
  ],
  [
    "/api/auth/oauth2/device_authorization",
    "POST",
    () => import("../src/app/api/auth/oauth2/device_authorization/route"),
  ],
  ["/api/auth/oauth2/revoke", "POST", () => import("../src/app/api/auth/oauth2/revoke/route")],
  ["/api/auth/oauth2/token", "POST", () => import("../src/app/api/auth/oauth2/token/route")],
  ["/api/auth/oauth2/userinfo", "GET", () => import("../src/app/api/auth/oauth2/userinfo/route")],
  [
    "/api/browser/resources/current",
    "GET",
    () => import("../src/app/api/browser/resources/current/route"),
  ],
  ["/api/me/grants", "GET", () => import("../src/app/api/me/grants/route")],
  ["/api/me/scopes", "GET", () => import("../src/app/api/me/scopes/route")],
  [
    "/api/me/browser-connections/current",
    "GET",
    () => import("../src/app/api/me/browser-connections/current/route"),
  ],
  [
    "/api/me/browser-connections/current/revoke",
    "POST",
    () => import("../src/app/api/me/browser-connections/current/revoke/route"),
  ],
] as const;

describe("browser-facing Weldall route CORS wiring", () => {
  it.each(browserRoutes)("enforces exact CORS on %s", async (path, method, load) => {
    const route = (await load()) as RouteModule;
    const actualHandler = route[method];
    expect(actualHandler).toBeTypeOf("function");
    expect(route.OPTIONS).toBeTypeOf("function");

    const preflight = await route.OPTIONS!(
      new Request(`https://weldall.example${path}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://spa.example",
          "access-control-request-method": method,
          "access-control-request-headers": "authorization, dpop",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://spa.example");
    expect(preflight.headers.get("access-control-allow-methods")).toBe(method);

    const rejected = await actualHandler!(
      new Request(`https://weldall.example${path}`, {
        method,
        headers: { origin: "https://attacker.example" },
      }),
    );
    expect(rejected.status).toBe(403);
    expect(rejected.headers.has("access-control-allow-origin")).toBe(false);
  });
});
