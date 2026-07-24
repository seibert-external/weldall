import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/server/auth/auth";

export const GET = oauthProviderOpenIdConfigMetadata(auth as any);
