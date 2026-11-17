import { z } from "zod";
import {
  authenticateConnectorActor,
  createConnectorErrorResponse,
  createJsonResponse,
  parseJsonRequestBody,
} from "@/server/connectors/http";
import {
  openAppPullRequest,
  PULL_REQUEST_BODY_LIMIT,
  PULL_REQUEST_TITLE_LIMIT,
} from "@/server/app-registry/pull-requests";

type Context = { params: Promise<{ id: string }> };

/**
 * Opens the pull request of one of the CLI caller's apps from a publish branch into the app's
 * default branch: `{ head, title, body }`. The server appends the line naming the person who
 * triggered it and requests the connector's reviewers; an open pull request of the same branch is
 * returned instead of a second one. The Git host's token stays on the server.
 */
export async function POST(request: Request, context: Context) {
  try {
    const actor = await authenticateConnectorActor({ request });
    const input = await parseJsonRequestBody({
      request,
      schema: z
        .object({
          head: z.string().min(1).max(255),
          title: z.string().min(1).max(PULL_REQUEST_TITLE_LIMIT),
          body: z.string().max(PULL_REQUEST_BODY_LIMIT).default(""),
        })
        .strict(),
    });
    return createJsonResponse(
      await openAppPullRequest({
        actor,
        appId: (await context.params).id,
        input,
        signal: request.signal,
      }),
    );
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
