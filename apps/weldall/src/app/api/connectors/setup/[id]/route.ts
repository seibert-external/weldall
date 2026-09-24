import { z } from "zod";
import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
  parseJsonRequestBody,
} from "@/server/connectors/http";
import { getAuthorizationAttempt, submitScopeSelection } from "@/server/connectors/connections";

type Context = { params: Promise<{ id: string }> };

/** Returns one browser-authenticated authorization attempt for the owner setup page. */
export async function GET(request: Request, context: Context) {
  try {
    return createJsonResponse(
      await getAuthorizationAttempt({
        actor: await authenticateConnectorActor({ request, browser: true }),
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
    const actor = await authenticateConnectorActor({ request, browser: true });
    const body = await parseJsonRequestBody({
      request,
      schema: z.object({ selectedScopes: z.array(z.string().max(160)).max(20) }).strict(),
    });
    return createJsonResponse(
      await submitScopeSelection({
        actor,
        id: (await context.params).id,
        selected: body.selectedScopes,
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
