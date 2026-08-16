import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { auth } from "@/server/auth/auth";
import { withRequestLogging } from "@/server/observability/http";

const endpoint = `${WELDALL_ISSUER}/api/auth/oauth2/userinfo`;
const handler = (request: Request) => auth.handler(new Request(endpoint, request));

export const GET = withRequestLogging("/api/auth/oauth2/userinfo", handler);
