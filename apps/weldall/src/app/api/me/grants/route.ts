import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { assignedScopesFor, resourceRegistryFor } from "@/server/policy/resources";
import { withBrowserCors } from "@/server/oauth/browser-cors";
import { authenticateBrowserConnectionRequest } from "@/server/oauth/browser-sessions";

const endpoint = `${WELDALL_ISSUER}/api/me/grants`;

async function get(request: Request) {
  try {
    if (request.headers.has("origin")) {
      const connection = await authenticateBrowserConnectionRequest(request, endpoint);
      if (!connection.userReference) throw new Error("browser connection subject is unavailable");
      const registry = await resourceRegistryFor(connection.userReference.email);
      const ownResource = registry.find(
        ({ resourceIdentifier }) => resourceIdentifier === connection.resourceIdentifier,
      );
      if (!ownResource) throw new Error("live browser resource policy is unavailable");
      return Response.json(ownResource.grantedScopes);
    }
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    return Response.json(await assignedScopesFor(user.email));
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

const handler = withBrowserCors(["GET"], get);
export const GET = withRequestLogging("/api/me/grants", handler);
export const OPTIONS = withRequestLogging("/api/me/grants", handler, { successLevel: "debug" });
