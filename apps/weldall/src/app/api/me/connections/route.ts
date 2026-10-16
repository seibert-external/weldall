import { z } from "zod";
import {
  authenticateConnectorActor,
  authenticateConnectorRuntimeActor,
  createConnectorErrorResponse,
  createJsonResponse,
  parseJsonRequestBody,
} from "@/server/connectors/http";
import { listAccessibleConnections, startConnection } from "@/server/connectors/core/connections";

/** Lists the authenticated CLI caller's managed connections without provider credentials. */
export async function GET(request: Request) {
  try {
    return createJsonResponse(
      await listAccessibleConnections(await authenticateConnectorRuntimeActor({ request })),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}

/** Starts a new or reconnecting managed-connection authorization attempt for the CLI caller. */
export async function POST(request: Request) {
  try {
    return createJsonResponse(
      await startConnection({
        actor: await authenticateConnectorActor({ request }),
        input: await parseJsonRequestBody({
          request,
          schema: z
            .object({
              connector: z.string().max(120),
              name: z.string().max(120),
              reconnect: z.string().max(160).optional(),
            })
            .strict(),
        }),
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
