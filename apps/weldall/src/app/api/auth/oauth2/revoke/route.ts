import { withRequestLogging } from "@/server/observability/http";
import { revocationFacade } from "@/server/oauth/facade";
import { withBrowserCors } from "@/server/oauth/browser-cors";

const handler = withBrowserCors(["POST"], revocationFacade);
export const POST = withRequestLogging("/api/auth/oauth2/revoke", handler);
export const OPTIONS = withRequestLogging("/api/auth/oauth2/revoke", handler, {
  successLevel: "debug",
});
