import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
} from "@/server/connectors/http";
import { checkGitHostConnector } from "@/server/connectors/core/git-host-checks";

type Context = { params: Promise<{ key: string }> };

/**
 * Administrator-only connect checklist of a Git host connector for the CLI
 * (`weldall connectors check <key>`): one line per check with pass, fail or unverifiable, the
 * reason and what to do. Read-only on the host; every run is audited.
 */
export async function GET(request: Request, context: Context) {
  try {
    const actor = await authenticateConnectorActor({ request });
    return createJsonResponse(
      await checkGitHostConnector({
        actor,
        connectorKey: (await context.params).key,
        signal: request.signal,
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
