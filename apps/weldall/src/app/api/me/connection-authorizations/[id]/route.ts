import { connectorActor, connectorErrorResponse, jsonResponse } from "@/server/connectors/http";
import { cancelAttempt, getAttempt } from "@/server/connectors/connections";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    return jsonResponse(await getAttempt(await connectorActor(request), (await context.params).id));
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    await cancelAttempt(await connectorActor(request), (await context.params).id);
    return jsonResponse({ cancelled: true });
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
