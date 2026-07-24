import { randomUUID } from "node:crypto";
import { auth } from "../auth/auth";

const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export async function createContext(request: Request) {
  const suppliedRequestId = request.headers.get("x-request-id")?.trim();
  return {
    request,
    requestId:
      suppliedRequestId && requestIdPattern.test(suppliedRequestId)
        ? suppliedRequestId
        : randomUUID(),
    session: await auth.api.getSession({ headers: request.headers }),
  };
}

export type TrpcContext = Awaited<ReturnType<typeof createContext>>;
