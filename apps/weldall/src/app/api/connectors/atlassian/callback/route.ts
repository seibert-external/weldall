import { completeConnection } from "@/server/connectors/core/connections";
import {
  authenticateConnectorBrowserActor,
  createConnectorErrorResponse,
  privateHeaders,
} from "@/server/connectors/http";
import { EnvelopeEncryptionError } from "@/server/connectors/envelope-errors";
import { ConnectorError } from "@/server/connectors/contracts";
import { logger } from "@/server/observability/logger";
import { WELDALL_ISSUER } from "@/server/oauth/constants";

const completion = (outcome: "success" | "cancelled" | "failed") =>
  new Response(null, {
    status: 303,
    headers: { ...privateHeaders, location: `${WELDALL_ISSUER}/api/connectors/result/${outcome}` },
  });
/** Fixed callback for resource-level Atlassian OAuth; core owns state and owner binding. */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    const state = query.get("state");
    if (
      !state ||
      state.length > 200 ||
      query.getAll("state").length !== 1 ||
      query.getAll("code").length > 1 ||
      query.getAll("error").length > 1
    )
      return completion("failed");
    return completion(
      await completeConnection({
        browser: await authenticateConnectorBrowserActor({ request }),
        state,
        code: query.has("error") ? null : query.get("code"),
        cancelled: query.get("error") === "access_denied",
      }),
    );
  } catch (error) {
    if (error instanceof EnvelopeEncryptionError) return createConnectorErrorResponse(error);
    logger.error(
      {
        event: "connector.connection.completion.failed",
        provider: "atlassian",
        error: { code: error instanceof ConnectorError ? error.code : "completion_error" },
      },
      "Connector connection completion failed",
    );
    return completion("failed");
  }
}
