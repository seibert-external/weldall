import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/server/auth/auth";
import { withRequestLogging } from "@/server/observability/http";

const handler = oauthProviderOpenIdConfigMetadata(auth as any);
export const GET = withRequestLogging("/.well-known/openid-configuration", handler, {
  successLevel: "debug",
});
