import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/server/auth/auth";
import { publicDiscoveryMetadata } from "@/server/oauth/metadata";
import { withRequestLogging } from "@/server/observability/http";

const providerMetadata = oauthProviderOpenIdConfigMetadata(auth as any);

async function get(request: Request) {
  const response = await providerMetadata(request);
  if (!response.ok) return response;
  return Response.json(publicDiscoveryMetadata(await response.json()), {
    headers: response.headers,
  });
}

export const GET = withRequestLogging("/.well-known/openid-configuration", get, {
  successLevel: "debug",
});
