import { connectorActor, connectorErrorResponse } from "@/server/connectors/http";
import { executeConnection } from "@/server/connectors/execution";
type Context = { params: Promise<{ key: string; path: string[] }> };
async function handle(request: Request, context: Context) {
  try {
    const actor = await connectorActor(request);
    const { key } = await context.params;
    const pathname = new URL(request.url).pathname;
    const prefix = `/connectors/${key}/`;
    if (!pathname.startsWith(prefix)) return new Response(null, { status: 400 });
    return await executeConnection(request, actor, key, `/${pathname.slice(prefix.length)}`);
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
