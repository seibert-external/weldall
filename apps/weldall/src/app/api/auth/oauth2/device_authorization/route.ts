import { withRequestLogging } from "@/server/observability/http";
import { withBrowserCors } from "@/server/oauth/browser-cors";
import {
  auditBrowserConnectionFailure,
  consumeBrowserEntranceRateLimit,
  startBrowserDeviceAuthorization,
} from "@/server/oauth/browser-connections";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";

async function post(request: Request) {
  try {
    return Response.json(
      await startBrowserDeviceAuthorization(request, undefined, { entranceConsumed: true }),
      {
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      },
    );
  } catch (error) {
    await auditBrowserConnectionFailure(request, "start", error);
    return loggedOauthErrorResponse(error);
  }
}

const handler = withBrowserCors(["POST"], post, {
  beforeActual: async (request) => {
    try {
      await consumeBrowserEntranceRateLimit(request, "start");
    } catch (error) {
      await auditBrowserConnectionFailure(request, "start", error);
      return loggedOauthErrorResponse(error);
    }
  },
  onRejectedActualOrigin: (request) =>
    auditBrowserConnectionFailure(request, "start", new Error("browser origin rejected")),
});
export const POST = withRequestLogging("/api/auth/oauth2/device_authorization", handler);
export const OPTIONS = withRequestLogging("/api/auth/oauth2/device_authorization", handler, {
  successLevel: "debug",
});
