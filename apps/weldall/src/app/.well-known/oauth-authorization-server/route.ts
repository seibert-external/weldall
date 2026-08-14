import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { db } from "@weldall/db";
import { auth } from "@/server/auth/auth";
import { extendOAuthMetadata } from "@/server/oauth/metadata";

const providerMetadata = oauthProviderAuthServerMetadata(auth as any);

export async function GET(request: Request) {
  const response = await providerMetadata(request);
  if (!response.ok) return response;
  const metadata = (await response.json()) as Record<string, unknown>;
  const identity = await db.installationIdentity.findUnique({ where: { id: "default" } });
  return Response.json(extendOAuthMetadata(metadata, identity?.installationId), {
    headers: { "cache-control": "public, max-age=60" },
  });
}
