import { z } from "zod";
import {
  connectorActor,
  connectorErrorResponse,
  connectorJsonBody,
} from "@/server/connectors/http";
import { issueConnectionLease } from "@/server/connectors/personal-connection-service";
import { withRequestLogging } from "@/server/observability/http";

const schema = z
  .object({ url: z.string().min(1).max(8_000), method: z.string().min(1).max(20) })
  .strict();

async function post(request: Request, context: { params: Promise<{ selector: string }> }) {
  try {
    const actor = await connectorActor(request);
    return Response.json(
      await issueConnectionLease(
        actor.id,
        (await context.params).selector,
        await connectorJsonBody(request, schema),
        actor,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export const POST = withRequestLogging("/api/me/connections/[selector]/lease", post);
