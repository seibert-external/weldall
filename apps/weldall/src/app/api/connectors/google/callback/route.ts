import { completeConnection } from "@/server/connectors/core/connections";
import { privateHeaders } from "@/server/connectors/http";
import { ConnectorError } from "@/server/connectors/contracts";
import { logger } from "@/server/observability/logger";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
/** Redirects the provider callback onto Weldall's locked-down browser result page. */
const createCompletionRedirect = (outcome: "success" | "cancelled" | "failed") =>
  new Response(null, {
    status: 303,
    headers: { ...privateHeaders, location: `${WELDALL_ISSUER}/api/connectors/result/${outcome}` },
  });
/** Handles Google's fixed OAuth callback route and commits the owner connection lifecycle. */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    const state = query.get("state");
    if (
      !state ||
      state.length > 200 ||
      query.getAll("state").length !== 1 ||
      query.getAll("code").length > 1
    )
      return createCompletionRedirect("failed");
    return createCompletionRedirect(
      await completeConnection({
        state,
        code: query.has("error") ? null : query.get("code"),
        cancelled: query.get("error") === "access_denied",
      }),
    );
  } catch (error) {
    logger.error(
      {
        event: "connector.connection.completion.failed",
        provider: "google",
        error: { code: error instanceof ConnectorError ? error.code : "completion_error" },
      },
      "Connector connection completion failed",
    );
    return createCompletionRedirect("failed");
  }
}
