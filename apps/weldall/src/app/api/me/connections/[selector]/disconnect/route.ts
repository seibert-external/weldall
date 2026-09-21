import { z } from "zod";
import {
  connectorActor,
  connectorErrorResponse,
  connectorJsonBody,
} from "@/server/connectors/http";
import { disconnectUserConnection } from "@/server/connectors/user-service";
import { withRequestLogging } from "@/server/observability/http";

const schema = z.object({ token: z.string().min(1).max(20_000).optional() }).strict();

async function post(request: Request, context: { params: Promise<{ selector: string }> }) {
  try {
    const actor = await connectorActor(request);
    const input = await connectorJsonBody(request, schema);
    return Response.json(
      await disconnectUserConnection(actor.id, (await context.params).selector, input.token, actor),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export const POST = withRequestLogging("/api/me/connections/[selector]/disconnect", post);
