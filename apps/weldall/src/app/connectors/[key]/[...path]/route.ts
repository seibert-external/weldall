import { authenticateConnectorActor, createConnectorErrorResponse } from "@/server/connectors/http";
import { executeConnectionRequest } from "@/server/connectors/execution";

type Context = { params: Promise<{ key: string; path: string[] }> };

/** Executes one framework-routed request through Weldall's owner-scoped managed connector proxy. */
async function handleConnectorRoute({ request, context }: { request: Request; context: Context }) {
  try {
    const actor = await authenticateConnectorActor({ request });
    const { key } = await context.params;
    const pathname = new URL(request.url).pathname;
    const prefix = `/connectors/${key}/`;
    if (!pathname.startsWith(prefix)) return new Response(null, { status: 400 });
    return await executeConnectionRequest({
      request,
      actor,
      connectorKey: key,
      path: `/${pathname.slice(prefix.length)}`,
    });
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}

/** Adapts Next's fixed route-handler signature to the connector proxy's named-parameter API. */
const handle = (request: Request, context: Context) => handleConnectorRoute({ request, context });

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
