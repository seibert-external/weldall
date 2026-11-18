import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import { confirmApp } from "@/server/app-registry/registry";

type Context = { params: Promise<{ id: string }> };

/**
 * The CLI caller confirms that one of their apps is still needed: its expiry moves to 90 days
 * from now. Only the owner may confirm; an unknown id and another person's app answer the same
 * 404. Takes no body. Audited as `app_confirmation.*`.
 */
export async function POST(request: Request, context: Context) {
  try {
    const actor = await authenticateConnectorActor({ request });
    return createJsonResponse(await confirmApp({ actor, appId: (await context.params).id }));
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
