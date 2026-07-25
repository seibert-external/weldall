import type { Context, Hono, MiddlewareHandler } from "hono";
import { initWeldall as initCore } from "./core.js";
import type { AuthContext, ScopePolicy, WeldallOptions } from "./types.js";

export type WeldallVariables = { weldallAuth: AuthContext };
type WeldallEnv = { Variables: WeldallVariables };

export function initWeldall(host: string, options: WeldallOptions) {
  const core = initCore(host, options);
  const protect =
    (policy: ScopePolicy = {}): MiddlewareHandler<WeldallEnv> =>
    async (c, next) => {
      const result = await core.verifyNoThrow(c.req.raw, policy);
      if (!result.ok) return result.response;
      c.set("weldallAuth", result.auth);
      await next();
    };
  const getAuth = (context: Context<WeldallEnv>): AuthContext => {
    const auth = context.get("weldallAuth");
    if (!auth) throw new Error("Weldall authentication middleware did not run");
    return auth;
  };
  const registerRoutes = (app: Hono<WeldallEnv>) => {
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
    app.post("/oauth/token", (c) => core.handlers.token(c.req.raw));
    return app;
  };
  return { ...core, protect, getAuth, registerRoutes };
}

export type HonoWeldall = ReturnType<typeof initWeldall>;
export * from "./types.js";
export { WeldallAuthError } from "./errors.js";
