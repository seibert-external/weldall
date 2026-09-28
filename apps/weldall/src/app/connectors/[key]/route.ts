import { authenticateConnectorActor, createConnectorErrorResponse } from "@/server/connectors/http";
import { executeConnectionRequest } from "@/server/connectors/core/execution";

type Context = { params: Promise<{ key: string }> };

/** Executes one framework-routed request through Weldall's owner-scoped managed connector proxy. */
async function handleConnectorRoute({ request, context }: { request: Request; context: Context }) {
  try {
    const actor = await authenticateConnectorActor({ request });
    const { key } = await context.params;
    return await executeConnectionRequest({
      request,
      actor,
      connectorKey: key,
    });
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}

/** Adapts Next's fixed route-handler signature to the connector proxy's named-parameter API. */
const handle = (request: Request, context: Context) => handleConnectorRoute({ request, context });

export {
  handle as GET,
  handle as HEAD,
  handle as OPTIONS,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
