import { z } from "zod";
import {
  connectorActor,
  connectorErrorResponse,
  jsonBody,
  jsonResponse,
} from "@/server/connectors/http";
import { listConnections, startConnection } from "@/server/connectors/connections";
export async function GET(request: Request) {
  try {
    return jsonResponse(await listConnections(await connectorActor(request)));
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    return jsonResponse(
      await startConnection(
        await connectorActor(request),
        await jsonBody(
          request,
          z
            .object({
              connector: z.string().max(120),
              name: z.string().max(120),
              reconnect: z.string().max(160).optional(),
            })
            .strict(),
        ),
      ),
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
