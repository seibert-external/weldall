import { auditRequestIdentifiers } from "../audit/service";
import { auth } from "../auth/auth";

export async function createContext(request: Request) {
  return {
    request,
    ...auditRequestIdentifiers(request),
    session: await auth.api.getSession({ headers: request.headers }),
  };
}

export type TrpcContext = Awaited<ReturnType<typeof createContext>>;
