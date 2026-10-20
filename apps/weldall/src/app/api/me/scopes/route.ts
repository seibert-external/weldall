import { WELDALL_ISSUER } from "@/server/oauth/constants";
import { authenticateCliApiRequest } from "@/server/oauth/cli-api";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { withRequestLogging } from "@/server/observability/http";
import { resourceRegistryFor } from "@/server/policy/resources";
import { authorizedNativeResources } from "@/server/mcp/native";

const endpoint = `${WELDALL_ISSUER}/api/me/scopes`;

async function get(request: Request) {
  try {
    const user = await authenticateCliApiRequest(request, {
      expectedUrl: endpoint,
      requiredScope: "weldall:scopes",
    });
    const resources = await resourceRegistryFor(user.email);
    // Opt-in avoids remote metadata work on existing HTTP and old-client paths.
    if (new URL(request.url).searchParams.get("mcp") === "1") {
      const metadata = await authorizedNativeResources(resources, [
        ...new Set(resources.flatMap((resource) => resource.grantedScopes)),
      ]);
      return Response.json(
        resources.map((resource) => ({
          ...resource,
          ...(metadata.has(resource.key) ? { mcp: metadata.get(resource.key) } : {}),
        })),
      );
    }
    return Response.json(resources);
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

export const GET = withRequestLogging("/api/me/scopes", get);
