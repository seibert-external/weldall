import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth";
import { denyCliConsentWithoutLoginScope, enforceCliConsent } from "@/server/auth/consent";
import { allowedAuthMethod, authorizePath, consentPath } from "@/server/auth/endpoint-allowlist";
import { installationCompleted } from "@/server/auth/login-service";
import { withRequestLogging } from "@/server/observability/http";

const handlers = toNextJsHandler(auth);

async function handle(request: Request) {
  const { pathname } = new URL(request.url);
  const method = allowedAuthMethod(request.method, pathname);
  if (!method) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

  if (method === "GET" && pathname === authorizePath) {
    if (!(await installationCompleted()))
      return Response.json(
        {
          error: "setup_required",
          error_description: "An operator must complete /setup before authorization.",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    return handlers.GET(enforceCliConsent(request));
  }
  if (method === "POST" && pathname === consentPath) {
    const denied = await denyCliConsentWithoutLoginScope(
      request,
      await auth.api.getSession({ headers: request.headers }),
    );
    if (denied) return denied;
  }
  return handlers[method](request);
}

export const GET = withRequestLogging("/api/auth/[...all]", handle);
export const POST = GET;
