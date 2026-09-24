import { db } from "@weldall/db";
import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import {
  buildConnectionMetadata,
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

/** Revokes and permanently removes one owner-selected connection. */
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
