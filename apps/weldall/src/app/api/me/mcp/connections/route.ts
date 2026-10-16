import { mcpConnectionsSchema, mcpConnectorKeySchema } from "@weldall/sdk/mcp";
import { authenticateConnectorRuntimeActor, createJsonResponse } from "@/server/connectors/http";
import { listAccessibleConnections } from "@/server/connectors/core/connections";
import { mcpErrorResponse } from "@/server/mcp/http";

export async function GET(request: Request) {
  try {
    const actor = await authenticateConnectorRuntimeActor({ request });
    const query = new URL(request.url).searchParams.get("connectorKey");
    const key = query === null ? undefined : mcpConnectorKeySchema.parse(query);
    const rows = await listAccessibleConnections(actor, key);
    return createJsonResponse(
      mcpConnectionsSchema.parse(
        rows
          .filter((row) => row.capabilities.includes("mcp"))
          .map(
            ({
              id,
              key,
              accessMode,
              connectorKey,
              name,
              accountName,
              status,
              connectorEnabled,
              capabilities,
              useScopes,
            }) => ({
              id,
              key,
              accessMode,
              connectorKey,
              name,
              accountName,
              status,
              connectorEnabled,
              capabilities,
              useScopes,
            }),
          ),
      ),
    );
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
