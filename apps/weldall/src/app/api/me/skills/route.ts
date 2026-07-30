import { oauthErrorResponse } from "@weldall/sdk";
import { after } from "next/server";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { listVisibleSkills } from "@/server/skills/service";

const endpoint = `${WELDALL_ISSUER}/api/me/skills`;

export async function GET(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    after(() => refreshDueCatalogs());
    return Response.json(await listVisibleSkills(user.email));
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
