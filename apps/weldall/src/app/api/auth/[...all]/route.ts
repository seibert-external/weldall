import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth";
import { denyCliConsentWithoutLoginScope, enforceCliConsent } from "@/server/auth/consent";

const handlers = toNextJsHandler(auth);

export const GET = (request: Request) => handlers.GET(enforceCliConsent(request));
export const POST = async (request: Request) =>
  (await denyCliConsentWithoutLoginScope(
    request,
    await auth.api.getSession({ headers: request.headers }),
  )) ?? handlers.POST(request);
