import { oauthErrorResponse } from "@weldall/sdk";
import { WELDALL_ISSUER } from "@/server/oauth/constants";
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
