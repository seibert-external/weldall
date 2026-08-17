import { withRequestLogging } from "@/server/observability/http";
import { withBrowserCors } from "@/server/oauth/browser-cors";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { currentBrowserConnectionStatus } from "@/server/oauth/browser-sessions";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";

const endpoint = `${WELDALL_ISSUER}/api/me/browser-connections/current`;

async function get(request: Request) {
  try {
    return Response.json(await currentBrowserConnectionStatus(request, endpoint), {
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

const handler = withBrowserCors(["GET"], get);
export const GET = withRequestLogging("/api/me/browser-connections/current", handler);
export const OPTIONS = withRequestLogging("/api/me/browser-connections/current", handler, {
  successLevel: "debug",
});
