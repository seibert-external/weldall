import { z } from "zod";
import {
  authenticateConnectorBrowserActor,
  createConnectorErrorResponse,
  createJsonResponse,
  parseJsonRequestBody,
} from "@/server/connectors/http";
import {
  getAuthorizationAttempt,
  submitScopeSelection,
} from "@/server/connectors/core/connections";

type Context = { params: Promise<{ id: string }> };

/** Returns one browser-authenticated authorization attempt for the owner setup page. */
export async function GET(request: Request, context: Context) {
  try {
    return createJsonResponse(
      await getAuthorizationAttempt({
        actor: await authenticateConnectorBrowserActor({ request }),
        id: (await context.params).id,
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}

/** Persists browser scope selection and returns the external Google consent URL. */
export async function POST(request: Request, context: Context) {
  try {
    const actor = await authenticateConnectorBrowserActor({ request });
    const body = await parseJsonRequestBody({
      request,
      schema: z.object({ selection: z.unknown() }).strict(),
    });
    return createJsonResponse(
      await submitScopeSelection({
        actor,
        id: (await context.params).id,
        selection: body.selection,
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
