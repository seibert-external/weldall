import { initWeldall as initCore } from "./core.js";
import type { AuthContext, ScopePolicy, WeldallOptions } from "./types.js";

export type WeldallAstroLocals = { weldallAuth?: AuthContext };
export type AstroContext = { request: Request; locals: WeldallAstroLocals };
export type AstroNext = () => Response | Promise<Response>;
export type AstroMiddleware = (
  context: AstroContext,
  next: AstroNext,
) => Response | Promise<Response>;
export type AstroEndpoint = (context: AstroContext) => Response | Promise<Response>;

export function initWeldall(host: string, options: WeldallOptions) {
  const core = initCore(host, options);
  const protect =
    (policy: ScopePolicy = {}): AstroMiddleware =>
    async (context, next) => {
      const result = await core.verifyNoThrow(context.request, policy);
      if (!result.ok) return result.response;
      context.locals.weldallAuth = result.auth;
      return next();
    };
  const getAuth = (context: Pick<AstroContext, "locals">): AuthContext => {
    const auth = context.locals.weldallAuth;
    if (!auth) throw new Error("Weldall authentication middleware did not run");
    return auth;
  };
  const handlers = {
    token: ((context: AstroContext) =>
      core.handlers.token(context.request)) satisfies AstroEndpoint,
    authorizationServerMetadata: ((context: AstroContext) =>
      core.handlers.authorizationServerMetadata(context.request)) satisfies AstroEndpoint,
    protectedResourceMetadata: ((context: AstroContext) =>
      core.handlers.protectedResourceMetadata(context.request)) satisfies AstroEndpoint,
    skills: ((context: AstroContext) =>
      core.handlers.skills(context.request)) satisfies AstroEndpoint,
    jwks: ((context: AstroContext) => core.handlers.jwks(context.request)) satisfies AstroEndpoint,
  };
  return { ...core, handlers, protect, getAuth };
}

export type AstroWeldall = ReturnType<typeof initWeldall>;
export * from "./types.js";
export * from "./skills.js";
export { WeldallAuthError } from "./errors.js";
