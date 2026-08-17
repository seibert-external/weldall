import { initWeldall as initCore } from "./core.js";
import type { AuthContext, BrowserCorsMethod, ScopePolicy, WeldallOptions } from "./types.js";

export type NextRouteContext = {
  params?: Promise<Record<string, string | string[] | undefined>>;
};
export type NextRouteHandler<C extends NextRouteContext = NextRouteContext> = (
  request: Request,
  context: C,
) => Response | Promise<Response>;
export type WeldallNextHandler<C extends NextRouteContext = NextRouteContext> = (
  request: Request,
  auth: AuthContext,
  context: C,
) => Response | Promise<Response>;

export function initWeldall(host: string, options: WeldallOptions) {
  const core = initCore(host, options);
  const withWeldall =
    <C extends NextRouteContext = NextRouteContext>(
      policy: ScopePolicy,
      handler: WeldallNextHandler<C>,
      methods?: readonly BrowserCorsMethod[],
    ): NextRouteHandler<C> =>
    async (request, context) => {
      if (request.method === "OPTIONS") return new Response(null, { status: 405 });
      const routeMethods = methods ?? [request.method as BrowserCorsMethod];
      if (!routeMethods.includes(request.method as BrowserCorsMethod))
        return new Response(null, { status: 405 });
      const rejected = core.cors.rejectActual(request, routeMethods);
      if (rejected) return rejected;
      const result = await core.verifyNoThrow(request, policy);
      const response = result.ok ? await handler(request, result.auth, context) : result.response;
      return core.cors.decorate(request, response, routeMethods);
    };
  const preflight =
    <C extends NextRouteContext = NextRouteContext>(
      methods: readonly BrowserCorsMethod[],
      expectedPathname: string,
    ): NextRouteHandler<C> =>
    (request) =>
      core.preflight(request, methods, expectedPathname);
  return { ...core, withWeldall, preflight };
}

export type NextWeldall = ReturnType<typeof initWeldall>;
export * from "./types.js";
export * from "./skills.js";
export { WeldallAuthError } from "./errors.js";
