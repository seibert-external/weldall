import { IAC_SCOPE_KEY } from "@weldall/db";
import { WeldallAuthError, type ReplayStore } from "@weldall/sdk";
import { auditRequestIdentifiers } from "../audit/service";
import {
  authenticateWeldallMachineApiRequest,
  canonicalWeldallApiRequestUrl,
} from "../oauth/machine-api";
import { postgresReplayStore } from "../oauth/replay";
import type { IacActor } from "./service";

export { verifyWeldallMachineToken } from "../oauth/machine-api";

export function canonicalIacRequestUrl(request: Request): string {
  return canonicalWeldallApiRequestUrl(request);
}

export async function requireIacMachine(
  request: Request,
  store: ReplayStore = postgresReplayStore,
  identifiers: ReturnType<typeof auditRequestIdentifiers> = auditRequestIdentifiers(request),
): Promise<IacActor> {
  try {
    return await authenticateWeldallMachineApiRequest(request, IAC_SCOPE_KEY, store, identifiers);
  } catch (error) {
    if (error instanceof WeldallAuthError) {
      throw new Response(error.message, {
        status: error.code === "insufficient_scope" ? 401 : error.status,
      });
    }
    throw error;
  }
}
