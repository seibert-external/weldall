import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { db } from "@weldall/db";
import { auth } from "@/server/auth/auth";
import { extendOAuthMetadata } from "@/server/oauth/metadata";
import { withRequestLogging } from "@/server/observability/http";
import { withBrowserCors } from "@/server/oauth/browser-cors";

const providerMetadata = oauthProviderAuthServerMetadata(auth as any);

async function get(request: Request) {
  const response = await providerMetadata(request);
  if (!response.ok) return response;
  const metadata = (await response.json()) as Record<string, unknown>;
  const identity = await db.installationIdentity.findUnique({ where: { id: "default" } });
  return Response.json(extendOAuthMetadata(metadata, identity?.installationId), {
    headers: {
      "cache-control": "public, max-age=60",
      // Remote status uses an opaque no-cors request to distinguish a removed
      // browser origin from an unavailable issuer. The metadata remains public.
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}

const handler = withBrowserCors(["GET"], get);
export const GET = withRequestLogging("/.well-known/oauth-authorization-server", handler, {
  successLevel: "debug",
});
export const OPTIONS = withRequestLogging("/.well-known/oauth-authorization-server", handler, {
  successLevel: "debug",
});
