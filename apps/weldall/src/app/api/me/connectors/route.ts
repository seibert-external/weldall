import { connectorActor, connectorErrorResponse } from "@/server/connectors/http";
import { listAvailableConnectors } from "@/server/connectors/user-service";
import { withRequestLogging } from "@/server/observability/http";

async function get(request: Request) {
  try {
    await connectorActor(request);
    return Response.json(
      { connectors: await listAvailableConnectors() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/connectors", get);
