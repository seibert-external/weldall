import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import {
  cancelAuthorizationAttempt,
  getAuthorizationAttempt,
} from "@/server/connectors/core/connections";

type Context = { params: Promise<{ id: string }> };

/** Returns one CLI caller's authorization attempt for interrupted setup polling. */
export async function GET(request: Request, context: Context) {
  try {
    return createJsonResponse(
      await getAuthorizationAttempt({
        actor: await authenticateConnectorActor({ request }),
        id: (await context.params).id,
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}

/** Cancels one CLI caller's authorization attempt and performs required provider cleanup. */
export async function DELETE(request: Request, context: Context) {
  try {
    await cancelAuthorizationAttempt({
      actor: await authenticateConnectorActor({ request }),
      id: (await context.params).id,
    });
    return createJsonResponse({ cancelled: true });
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
