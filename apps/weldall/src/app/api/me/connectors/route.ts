import { connectorActor, connectorErrorResponse, jsonResponse } from "@/server/connectors/http";
import { listConnectors } from "@/server/connectors/connections";
export async function GET(request: Request) {
  try {
    await connectorActor(request);
    return jsonResponse(await listConnectors());
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
