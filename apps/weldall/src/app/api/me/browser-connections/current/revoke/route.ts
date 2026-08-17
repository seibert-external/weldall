import { withRequestLogging } from "@/server/observability/http";
import { withBrowserCors } from "@/server/oauth/browser-cors";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { revokeCurrentBrowserConnection } from "@/server/oauth/browser-sessions";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";

const endpoint = `${WELDALL_ISSUER}/api/me/browser-connections/current/revoke`;

async function post(request: Request) {
  try {
    return Response.json(await revokeCurrentBrowserConnection(request, endpoint), {
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

const handler = withBrowserCors(["POST"], post);
export const POST = withRequestLogging("/api/me/browser-connections/current/revoke", handler);
export const OPTIONS = withRequestLogging("/api/me/browser-connections/current/revoke", handler, {
  successLevel: "debug",
});
