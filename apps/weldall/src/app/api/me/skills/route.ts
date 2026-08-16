import { after } from "next/server";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { listVisibleSkills } from "@/server/skills/service";

const endpoint = `${WELDALL_ISSUER}/api/me/skills`;

async function get(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    after(() => refreshDueCatalogs());
    return Response.json(await listVisibleSkills(user.email));
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/skills", get);
