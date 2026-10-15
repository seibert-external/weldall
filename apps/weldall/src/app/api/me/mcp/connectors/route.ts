import { authenticateConnectorActor, createJsonResponse } from "@/server/connectors/http";
import { listMcpConnectors } from "@/server/mcp/broker";
import { mcpErrorResponse } from "@/server/mcp/http";

export async function GET(request: Request) {
  try {
    return createJsonResponse(await listMcpConnectors(await authenticateConnectorActor({ request })));
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
