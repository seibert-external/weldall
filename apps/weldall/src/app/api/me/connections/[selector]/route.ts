import { db } from "@weldall/db";
import { connectorActor, connectorErrorResponse, jsonResponse } from "@/server/connectors/http";
import {
  connectionMetadata,
  deleteConnection,
  disconnect,
  ownedConnection,
} from "@/server/connectors/connections";
type Context = { params: Promise<{ selector: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const row = await ownedConnection(
      db,
      (await context.params).selector,
      await connectorActor(request),
    );
    return jsonResponse(connectionMetadata(row, row.connector));
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    return jsonResponse(
      await disconnect(await connectorActor(request), (await context.params).selector),
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    await deleteConnection(await connectorActor(request), (await context.params).selector);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
