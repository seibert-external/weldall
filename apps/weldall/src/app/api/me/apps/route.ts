import { after } from "next/server";
import { listVisibleApps } from "@/server/apps/service";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { refreshDueCatalogs } from "@/server/skills/catalogs";

const endpoint = `${WELDALL_ISSUER}/api/me/apps`;

/** The apps the signed-in person may see; see `listVisibleApps`. */
async function get(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    after(() => refreshDueCatalogs());
    return Response.json(await listVisibleApps(user), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/apps", get);
