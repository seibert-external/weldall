import { toNextJsHandler } from "better-auth/next-js";
import { z } from "zod";
import { auth } from "@/server/auth/auth";
import { denyCliConsentWithoutLoginScope, enforceCliConsent } from "@/server/auth/consent";
import { installationCompleted } from "@/server/auth/login-service";
import { withRequestLogging } from "@/server/observability/http";

const handlers = toNextJsHandler(auth);
const callbackPrefix = "/api/auth/callback/";
const providerId = z.uuid();

// Token, revocation and userinfo have dedicated routes; never forward them from this catch-all.
async function handle(request: Request) {
  const { pathname } = new URL(request.url);
  switch (`${request.method} ${pathname}`) {
    case "GET /api/auth/oauth2/authorize":
      if (!(await installationCompleted()))
        return Response.json(
          {
            error: "setup_required",
            error_description: "An operator must complete /setup before authorization.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      return handlers.GET(enforceCliConsent(request));
    case "GET /api/auth/get-session":
    case "GET /api/auth/oidc/admin-providers":
    case "GET /api/auth/error":
      return handlers.GET(request);
    case "POST /api/auth/oauth2/consent": {
      const denied = await denyCliConsentWithoutLoginScope(
        request,
        await auth.api.getSession({ headers: request.headers }),
      );
      return denied ?? handlers.POST(request);
    }
    case "POST /api/auth/sign-out":
    case "POST /api/auth/oidc/start":
    case "POST /api/auth/oidc/setup":
    case "POST /api/auth/oidc/admin-draft":
    case "POST /api/auth/oidc/admin-test":
    case "POST /api/auth/oidc/admin-save":
      return handlers.POST(request);
  }
  if (
    request.method === "GET" &&
    pathname.startsWith(callbackPrefix) &&
    providerId.safeParse(pathname.slice(callbackPrefix.length)).success
  )
    return handlers.GET(request);
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

export const GET = withRequestLogging("/api/auth/[...all]", handle);
export const POST = GET;
