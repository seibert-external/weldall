import { WELDALL_ISSUER, oauthErrorResponse } from "@weldall/oauth";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { listVisibleSkills } from "@/server/skills/service";

const endpoint = `${WELDALL_ISSUER}/api/me/skills`;

export async function GET(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    return Response.json(await listVisibleSkills(user.email));
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
