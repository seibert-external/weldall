import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth";
import { denyCliConsentWithoutLoginScope, enforceCliConsent } from "@/server/auth/consent";
import { withRequestLogging } from "@/server/observability/http";

const handlers = toNextJsHandler(auth);
const get = (request: Request) => handlers.GET(enforceCliConsent(request));
const post = async (request: Request) =>
  (await denyCliConsentWithoutLoginScope(
    request,
    await auth.api.getSession({ headers: request.headers }),
  )) ?? handlers.POST(request);

export const GET = withRequestLogging("/api/auth/[...all]", get);
export const POST = withRequestLogging("/api/auth/[...all]", post);
