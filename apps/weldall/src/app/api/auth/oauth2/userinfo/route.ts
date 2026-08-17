import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { auth } from "@/server/auth/auth";
import { withRequestLogging } from "@/server/observability/http";
import { withBrowserCors } from "@/server/oauth/browser-cors";
import { authenticateBrowserConnectionRequest } from "@/server/oauth/browser-sessions";

const endpoint = `${WELDALL_ISSUER}/api/auth/oauth2/userinfo`;
const authHandler = async (request: Request) => {
  if (request.headers.has("origin")) await authenticateBrowserConnectionRequest(request, endpoint);
  return auth.handler(new Request(endpoint, request));
};
const handler = withBrowserCors(["GET"], authHandler);

export const GET = withRequestLogging("/api/auth/oauth2/userinfo", handler);
export const OPTIONS = withRequestLogging("/api/auth/oauth2/userinfo", handler, {
  successLevel: "debug",
});
