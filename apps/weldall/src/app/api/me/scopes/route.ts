import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { resourceRegistryFor } from "@/server/policy/resources";
import { withBrowserCors } from "@/server/oauth/browser-cors";
import { authenticateBrowserConnectionRequest } from "@/server/oauth/browser-sessions";

const endpoint = `${WELDALL_ISSUER}/api/me/scopes`;

async function get(request: Request) {
  try {
    if (request.headers.has("origin")) {
      const connection = await authenticateBrowserConnectionRequest(request, endpoint);
      if (!connection.userReference) throw new Error("browser connection subject is unavailable");
      const registry = await resourceRegistryFor(connection.userReference.email);
      return Response.json(
        registry.filter(
          ({ resourceIdentifier }) => resourceIdentifier === connection.resourceIdentifier,
        ),
      );
    }
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    return Response.json(await resourceRegistryFor(user.email));
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

const handler = withBrowserCors(["GET"], get);
export const GET = withRequestLogging("/api/me/scopes", handler);
export const OPTIONS = withRequestLogging("/api/me/scopes", handler, { successLevel: "debug" });
