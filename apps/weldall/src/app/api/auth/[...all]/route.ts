import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth";
import { enforceCliConsent } from "@/server/auth/consent";

const handlers = toNextJsHandler(auth);

export const GET = (request: Request) => handlers.GET(enforceCliConsent(request));
export const POST = handlers.POST;
