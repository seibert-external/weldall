import { mcpResourceReadSchema } from "@weldall/sdk/mcp";
import { authenticateConnectorRuntimeActor, createJsonResponse } from "@/server/connectors/http";
import { executeMcpOperation } from "@/server/mcp/broker";
import { parseMcpBody, mcpErrorResponse } from "@/server/mcp/http";

export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  try {
    const actor = await authenticateConnectorRuntimeActor({ request });
    const { key } = await context.params;
    const body = await parseMcpBody(request, mcpResourceReadSchema);
    return createJsonResponse(
      await executeMcpOperation({
        actor,
        connectorKey: key,
        operation: "read-resource",
        body,
        signal: request.signal,
      }),
    );
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
