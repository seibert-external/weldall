import { after } from "next/server";
import { listVisibleAgents } from "@/server/agents/service";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { refreshDueCatalogs } from "@/server/skills/catalogs";

const endpoint = `${WELDALL_ISSUER}/api/me/agents`;

/** The shared agents the signed-in person may use; see `listVisibleAgents`. */
async function get(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    after(() => refreshDueCatalogs());
    return Response.json(await listVisibleAgents(user), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/agents", get);
