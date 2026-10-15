import { mcpToolCallSchema } from "@weldall/sdk/mcp";
import { authenticateConnectorActor, createJsonResponse } from "@/server/connectors/http";
import { executeMcpOperation } from "@/server/mcp/broker";
import { parseMcpBody, mcpErrorResponse } from "@/server/mcp/http";

export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  try {
    const actor = await authenticateConnectorActor({ request });
    const { key } = await context.params;
    const body = await parseMcpBody(request, mcpToolCallSchema);
    return createJsonResponse(
      await executeMcpOperation({
        actor,
        connectorKey: key,
        operation: "call",
        body,
        signal: request.signal,
      }),
    );
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
