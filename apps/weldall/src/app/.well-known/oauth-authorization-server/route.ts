import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/server/auth/auth";

export const GET = oauthProviderAuthServerMetadata(auth as any);
