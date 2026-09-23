import { z } from "zod";
import {
  connectorActor,
  connectorErrorResponse,
  jsonBody,
  jsonResponse,
} from "@/server/connectors/http";
import { getAttempt, submitSelection } from "@/server/connectors/connections";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    return jsonResponse(
      await getAttempt(await connectorActor(request, true), (await context.params).id),
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const actor = await connectorActor(request, true);
    const body = await jsonBody(
      request,
      z.object({ selectedScopes: z.array(z.string().max(160)).max(20) }).strict(),
    );
    return jsonResponse(
      await submitSelection(actor, (await context.params).id, body.selectedScopes),
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
