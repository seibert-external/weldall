import { z } from "zod";
import {
  connectorActor,
  connectorErrorResponse,
  connectorJsonBody,
} from "@/server/connectors/http";
import {
  listUserConnections,
  startConnectionAuthorization,
} from "@/server/connectors/user-service";
import { withRequestLogging } from "@/server/observability/http";

const createSchema = z
  .object({
    connector: z.string().min(1).max(191),
    name: z.string().min(1).max(120),
    deviceId: z.string().min(20).max(128),
  })
  .strict();

async function get(request: Request) {
  try {
    const actor = await connectorActor(request);
    return Response.json(
      { connections: await listUserConnections(actor.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

async function post(request: Request) {
  try {
    const actor = await connectorActor(request);
    const result = await startConnectionAuthorization(
      await connectorJsonBody(request, createSchema),
      actor,
    );
    return Response.json(result, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/connections", get);
export const POST = withRequestLogging("/api/me/connections", post);
