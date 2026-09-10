import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth";
import { denyCliConsentWithoutLoginScope, enforceCliConsent } from "@/server/auth/consent";
import { withRequestLogging } from "@/server/observability/http";
import { installationCompleted } from "@/server/auth/login-service";

const handlers = toNextJsHandler(auth);
const get = async (request: Request) => {
  if (
    new URL(request.url).pathname.replace(/\/+$/, "") === "/api/auth/oauth2/authorize" &&
    !(await installationCompleted())
  )
    return Response.json(
      {
        error: "setup_required",
        error_description: "An operator must complete /setup before authorization.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  return handlers.GET(enforceCliConsent(request));
};
const post = async (request: Request) => {
  if (new URL(request.url).pathname.replace(/\/+$/, "") === "/api/auth/oauth2/consent") {
    const denied = await denyCliConsentWithoutLoginScope(
      request,
      await auth.api.getSession({ headers: request.headers }),
    );
    if (denied) return denied;
  }
  return handlers.POST(request);
};

export const GET = withRequestLogging("/api/auth/[...all]", get);
export const POST = withRequestLogging("/api/auth/[...all]", post);
