import { z } from "zod";
import {
  connectorActor,
  connectorErrorResponse,
  connectorJsonBody,
} from "@/server/connectors/http";
import { getUserConnection, renameUserConnection } from "@/server/connectors/user-service";
import { withRequestLogging } from "@/server/observability/http";

const renameSchema = z
  .object({ name: z.string().min(1).max(120), expectedVersion: z.number().int().positive() })
  .strict();

async function get(request: Request, context: { params: Promise<{ selector: string }> }) {
  try {
    const actor = await connectorActor(request);
    return Response.json(await getUserConnection(actor.id, (await context.params).selector), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

async function patch(request: Request, context: { params: Promise<{ selector: string }> }) {
  try {
    const actor = await connectorActor(request);
    const input = await connectorJsonBody(request, renameSchema);
    return Response.json(
      await renameUserConnection(
        actor.id,
        (await context.params).selector,
        input.name,
        input.expectedVersion,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/connections/[selector]", get);
export const PATCH = withRequestLogging("/api/me/connections/[selector]", patch);
