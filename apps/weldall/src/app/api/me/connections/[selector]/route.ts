import { db } from "@weldall/db";
import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import {
  buildConnectionMetadata,
  deleteConnection,
  disconnectConnection,
  findOwnedConnection,
} from "@/server/connectors/connections";

type Context = { params: Promise<{ selector: string }> };

/** Returns credential-free metadata for one owner-selected managed connection. */
export async function GET(request: Request, context: Context) {
  try {
    const row = await findOwnedConnection({
      tx: db,
      selector: (await context.params).selector,
      actor: await authenticateConnectorActor({ request }),
    });
    return createJsonResponse(buildConnectionMetadata({ row, connector: row.connector }));
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}

/** Disconnects one owner-selected connection and attempts explicit provider revocation. */
export async function POST(request: Request, context: Context) {
  try {
    return createJsonResponse(
      await disconnectConnection({
        actor: await authenticateConnectorActor({ request }),
        selector: (await context.params).selector,
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}

/** Deletes one fully disconnected owner-selected connection. */
export async function DELETE(request: Request, context: Context) {
  try {
    await deleteConnection({
      actor: await authenticateConnectorActor({ request }),
      selector: (await context.params).selector,
    });
    return createJsonResponse({ deleted: true });
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
