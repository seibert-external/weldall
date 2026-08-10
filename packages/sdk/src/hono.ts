import type { Context, Hono, MiddlewareHandler } from "hono";
import { initWeldall as initCore } from "./core.js";
import { SKILL_CATALOG_PATH } from "./skills.js";
import { initWorkloadVerifier } from "./workload.js";
import type {
  AuthContext,
  ScopePolicy,
  WeldallOptions,
  WorkloadAuthContext,
  WorkloadVerifierOptions,
} from "./types.js";

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
    app.get(SKILL_CATALOG_PATH, (c) => core.handlers.skills(c.req.raw));
    app.post("/oauth/token", (c) => core.handlers.token(c.req.raw));
    return app;
  };
  return { ...core, protect, getAuth, registerRoutes };
}

export type HonoWeldall = ReturnType<typeof initWeldall>;

export type WorkloadVariables = { weldallWorkloadAuth: WorkloadAuthContext };
type WorkloadEnv = { Variables: WorkloadVariables };

export function initWorkloadAuth(host: string, options: WorkloadVerifierOptions) {
  const core = initWorkloadVerifier(host, options);
  const protectWorkload =
    (policy: ScopePolicy = {}): MiddlewareHandler<WorkloadEnv> =>
    async (context, next) => {
      const result = await core.verifyNoThrow(context.req.raw, policy);
      if (!result.ok) return result.response;
      context.set("weldallWorkloadAuth", result.auth);
      await next();
    };
  const getWorkloadAuth = (context: Context<WorkloadEnv>): WorkloadAuthContext => {
    const auth = context.get("weldallWorkloadAuth");
    if (!auth) throw new Error("Weldall workload authentication middleware did not run");
    return auth;
  };
  return { ...core, protectWorkload, getWorkloadAuth };
}

export type HonoWorkloadAuth = ReturnType<typeof initWorkloadAuth>;
export * from "./types.js";
export * from "./skills.js";
export { WeldallAuthError } from "./errors.js";
