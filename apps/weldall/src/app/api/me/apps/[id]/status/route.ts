import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import { readAppStatus } from "@/server/app-registry/status";

type Context = { params: Promise<{ id: string }> };

/**
 * Read-only status of one of the CLI caller's apps: the current pull request (or the one of
 * `?branch=<publish branch>`) with its reviews and checks, and the CI's preview and live links.
 * Review texts and check names come from the customer's Git and are returned as sanitised data.
 * `publish` carries what the CLI's publish step needs from the Git host: protected paths and the
 * identity of the commit it pushes.
 */
export async function GET(request: Request, context: Context) {
  try {
    const actor = await authenticateConnectorActor({ request });
    const branch = new URL(request.url).searchParams.get("branch");
    return createJsonResponse(
      await readAppStatus({
        actor,
        appId: (await context.params).id,
        branch: branch ?? undefined,
        signal: request.signal,
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
