import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import { listConnectors } from "@/server/connectors/connections";

/** Lists enabled connector catalogs and scope choices for the authenticated CLI caller. */
export async function GET(request: Request) {
  try {
    await authenticateConnectorActor({ request });
    return createJsonResponse(await listConnectors());
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
