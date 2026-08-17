import { withRequestLogging } from "@/server/observability/http";
import { tokenFacade } from "@/server/oauth/facade";
import { withBrowserCors } from "@/server/oauth/browser-cors";

const handler = withBrowserCors(["POST"], tokenFacade);
export const POST = withRequestLogging("/api/auth/oauth2/token", handler);
export const OPTIONS = withRequestLogging("/api/auth/oauth2/token", handler, {
  successLevel: "debug",
});
