import { completeConnection } from "@/server/connectors/core/connections";
import {
  authenticateConnectorBrowserActor,
  createConnectorErrorResponse,
  privateHeaders,
} from "@/server/connectors/http";
import { WELDALL_ISSUER } from "@/server/oauth/constants";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    const state = query.get("state");
    let outcome: "success" | "cancelled" | "failed" = "failed";
    if (
      state &&
      state.length <= 200 &&
      query.getAll("state").length === 1 &&
      query.getAll("code").length <= 1 &&
      query.getAll("error").length <= 1 &&
      (query.get("code")?.length ?? 0) <= 8192
    ) {
      outcome = await completeConnection({
        browser: await authenticateConnectorBrowserActor({ request }),
        state,
        code: query.has("error") ? null : query.get("code"),
        cancelled: query.get("error") === "access_denied",
      });
    }
    return new Response(null, {
      status: 303,
      headers: { ...privateHeaders, location: `${WELDALL_ISSUER}/connections/result/${outcome}` },
    });
  } catch (error) {
    return createConnectorErrorResponse(error);
  }
}
