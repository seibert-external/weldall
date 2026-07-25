import { initWeldall as initCore } from "./core.js";
import type { AuthContext, ScopePolicy, WeldallOptions } from "./types.js";

export type NextRouteContext = { params?: Promise<Record<string, string | string[] | undefined>> };
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
    ): NextRouteHandler<C> =>
    async (request, context) => {
      const result = await core.verifyNoThrow(request, policy);
      return result.ok ? handler(request, result.auth, context) : result.response;
    };
  return { ...core, withWeldall };
}

export type NextWeldall = ReturnType<typeof initWeldall>;
export * from "./types.js";
export { WeldallAuthError } from "./errors.js";
