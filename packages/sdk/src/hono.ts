import type { Context, Hono, MiddlewareHandler } from "hono";
import { initWeldall as initCore } from "./core.js";
import { SKILL_CATALOG_PATH } from "./skills.js";
import type { AuthContext, BrowserCorsMethod, ScopePolicy, WeldallOptions } from "./types.js";

export type WeldallVariables = { weldallAuth: AuthContext };
type WeldallEnv = { Variables: WeldallVariables };

export function initWeldall(host: string, options: WeldallOptions) {
  const core = initCore(host, options);
  const protect =
    (
      policy: ScopePolicy = {},
      methods?: readonly BrowserCorsMethod[],
    ): MiddlewareHandler<WeldallEnv> =>
    async (c, next) => {
      if (c.req.method === "OPTIONS") return new Response(null, { status: 405 });
      const routeMethods = methods ?? [c.req.method as BrowserCorsMethod];
      if (!routeMethods.includes(c.req.method as BrowserCorsMethod))
        return new Response(null, { status: 405 });
      const rejected = core.cors.rejectActual(c.req.raw, routeMethods);
      if (rejected) return rejected;
      const result = await core.verifyNoThrow(c.req.raw, policy);
      if (!result.ok) return core.cors.decorate(c.req.raw, result.response, routeMethods);
      c.set("weldallAuth", result.auth);
      await next();
      c.res = core.cors.decorate(c.req.raw, c.res, routeMethods);
    };
  const preflight =
    (methods: readonly BrowserCorsMethod[]): MiddlewareHandler<WeldallEnv> =>
    async (c) =>
      core.preflight(c.req.raw, methods);
  const getAuth = (context: Context<WeldallEnv>): AuthContext => {
    const auth = context.get("weldallAuth");
    if (!auth) throw new Error("Weldall authentication middleware did not run");
    return auth;
  };
  const registerRoutes = (app: Hono<WeldallEnv>) => {
    const getPreflight: MiddlewareHandler<WeldallEnv> = async (c) =>
      core.cors.preflight(c.req.raw, ["GET"]) ?? new Response(null, { status: 405 });
    const postPreflight: MiddlewareHandler<WeldallEnv> = async (c) =>
      core.cors.preflight(c.req.raw, ["POST"]) ?? new Response(null, { status: 405 });
    app.options("/.well-known/oauth-authorization-server", getPreflight);
    app.options("/.well-known/oauth-protected-resource", getPreflight);
    app.options("/.well-known/oauth-protected-resource/*", getPreflight);
    app.options("/.well-known/jwks.json", getPreflight);
    app.options(SKILL_CATALOG_PATH, getPreflight);
    app.options("/oauth/token", postPreflight);
    app.get("/.well-known/oauth-authorization-server", (c) =>
      core.handlers.authorizationServerMetadata(c.req.raw),
    );
    app.get("/.well-known/oauth-protected-resource", (c) =>
      core.handlers.protectedResourceMetadata(c.req.raw),
    );
    app.get("/.well-known/oauth-protected-resource/*", (c) =>
      core.handlers.protectedResourceMetadata(c.req.raw),
    );
    app.get("/.well-known/jwks.json", (c) => core.handlers.jwks(c.req.raw));
    app.get(SKILL_CATALOG_PATH, (c) => core.handlers.skills(c.req.raw));
    app.post("/oauth/token", (c) => core.handlers.token(c.req.raw));
    return app;
  };
  return { ...core, protect, preflight, getAuth, registerRoutes };
}

export type HonoWeldall = ReturnType<typeof initWeldall>;
export * from "./types.js";
export * from "./skills.js";
export { WeldallAuthError } from "./errors.js";
