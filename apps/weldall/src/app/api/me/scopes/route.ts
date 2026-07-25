import { WELDALL_ISSUER, oauthErrorResponse } from "@weldall/oauth";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { resourceRegistryFor } from "@/server/policy/resources";

const endpoint = `${WELDALL_ISSUER}/api/me/scopes`;

export async function GET(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    return Response.json(await resourceRegistryFor(user.email));
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
