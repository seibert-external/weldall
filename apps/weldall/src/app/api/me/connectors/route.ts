import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import { listConnectors } from "@/server/connectors/core/connections";

/** Lists enabled connector catalogs and scope choices for the authenticated CLI caller. */
export async function GET(request: Request) {
  try {
    const actor = await authenticateConnectorActor({ request });
    return createJsonResponse(await listConnectors(actor));
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
