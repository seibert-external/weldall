import { z } from "zod";
import {
  connectorActor,
  connectorErrorResponse,
  connectorJsonBody,
} from "@/server/connectors/http";
import { restartConnectionAuthorization } from "@/server/connectors/user-service";
import { withRequestLogging } from "@/server/observability/http";

const schema = z.object({ deviceId: z.string().min(20).max(128) }).strict();

async function post(request: Request, context: { params: Promise<{ selector: string }> }) {
  try {
    const actor = await connectorActor(request);
    const { deviceId } = await connectorJsonBody(request, schema);
    return Response.json(
      await restartConnectionAuthorization(
        actor.id,
        (await context.params).selector,
        deviceId,
        actor,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export const POST = withRequestLogging("/api/me/connections/[selector]/authorization", post);
