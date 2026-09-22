import { z } from "zod";
import {
  connectorActor,
  connectorErrorResponse,
  connectorJsonBody,
} from "@/server/connectors/http";
import { refreshUserConnection } from "@/server/connectors/personal-connection-service";
import { withRequestLogging } from "@/server/observability/http";

const schema = z.object({ refreshToken: z.string().min(1).max(20_000) }).strict();

async function post(request: Request, context: { params: Promise<{ selector: string }> }) {
  try {
    const actor = await connectorActor(request);
    const input = await connectorJsonBody(request, schema);
    return Response.json(
      await refreshUserConnection(
        actor.id,
        (await context.params).selector,
        input.refreshToken,
        actor,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export const POST = withRequestLogging("/api/me/connections/[selector]/refresh", post);
