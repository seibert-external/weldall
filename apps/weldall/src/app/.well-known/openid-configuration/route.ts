import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/server/auth/auth";
import { withRequestLogging } from "@/server/observability/http";
import { withBrowserCors } from "@/server/oauth/browser-cors";

const metadataHandler = oauthProviderOpenIdConfigMetadata(auth as any);
const handler = withBrowserCors(["GET"], metadataHandler);
export const GET = withRequestLogging("/.well-known/openid-configuration", handler, {
  successLevel: "debug",
});
export const OPTIONS = withRequestLogging("/.well-known/openid-configuration", handler, {
  successLevel: "debug",
});
