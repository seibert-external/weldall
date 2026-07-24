import { WELDALL_ISSUER } from "@weldall/oauth";
import { auth } from "@/server/auth/auth";

const endpoint = `${WELDALL_ISSUER}/api/auth/oauth2/userinfo`;

export const GET = (request: Request) => auth.handler(new Request(endpoint, request));
