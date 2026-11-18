import { APP_REGISTRY_READ_SCOPE_KEY } from "@weldall/db";
import { WeldallAuthError } from "@weldall/sdk";
import { z } from "zod";
import { loggedOauthErrorResponse } from "../oauth/error-response";
import { authenticateWeldallMachineApiRequest } from "../oauth/machine-api";
import { InvalidAppCursorError, listAppsForMachine, MACHINE_APP_PAGE_SIZE } from "./registry";
import { APP_STATES } from "./state";

const querySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MACHINE_APP_PAGE_SIZE.maximum)
      .default(MACHINE_APP_PAGE_SIZE.default),
    cursor: z.string().min(1).max(500).optional(),
    state: z.enum(APP_STATES).optional(),
  })
  .strict();

/**
 * `GET /api/app-registry/v1/apps`: the app registry for the customer's own tools, read-only.
 * Requires a machine token with `weldall:app-registry-read` for the Weldall API. Query:
 * `limit` (1-200, default 100), `cursor` (the previous page's `nextCursor`) and `state`.
 */
export async function appRegistryApi(request: Request): Promise<Response> {
  try {
    await authenticateWeldallMachineApiRequest(request, APP_REGISTRY_READ_SCOPE_KEY);
    const parameters = new URL(request.url).searchParams;
    const query = querySchema.safeParse(Object.fromEntries(parameters));
    if (!query.success || new Set(parameters.keys()).size !== [...parameters.keys()].length)
      throw new WeldallAuthError(
        "invalid_request",
        "Use limit (1-200), cursor and state (active, expiring_soon or expired), each at most once.",
      );
    return Response.json(await listAppsForMachine(query.data), {
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  } catch (error) {
    if (error instanceof InvalidAppCursorError)
      return loggedOauthErrorResponse(
        new WeldallAuthError("invalid_request", "cursor is not one this server issued"),
      );
    return loggedOauthErrorResponse(error);
  }
}
