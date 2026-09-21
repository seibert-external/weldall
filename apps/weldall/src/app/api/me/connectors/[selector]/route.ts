import { connectorActor, connectorErrorResponse } from "@/server/connectors/http";
import { getAvailableConnector } from "@/server/connectors/user-service";
import { withRequestLogging } from "@/server/observability/http";

async function get(request: Request, context: { params: Promise<{ selector: string }> }) {
  try {
    await connectorActor(request);
    return Response.json(await getAvailableConnector((await context.params).selector), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/connectors/[selector]", get);
