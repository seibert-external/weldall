import { withRequestLogging } from "@/server/observability/http";
import { withBrowserCors } from "@/server/oauth/browser-cors";
import {
  browserClientIdForResourceKey,
  browserOriginsForResource,
} from "@/server/oauth/browser-resources";
import { loggedOauthErrorResponse } from "@/server/oauth/error-response";
import { db } from "@weldall/db";
import { WeldallAuthError } from "@weldall/sdk";

async function get(request: Request) {
  try {
    const url = new URL(request.url);
    const values = url.searchParams.getAll("resource");
    if (values.length !== 1 || !values[0]) throw new WeldallAuthError("invalid_request");
    const origin = request.headers.get("origin");
    const resource = await db.downstreamResource.findUnique({
      where: { resourceIdentifier: values[0] },
      include: {
        requestPrefixes: { orderBy: { urlPrefix: "asc" } },
        scopes: { include: { scope: { select: { key: true } } } },
      },
    });
    if (!origin || !resource?.enabled || !browserOriginsForResource(resource).includes(origin))
      throw new WeldallAuthError("invalid_client", "resource or origin is unavailable", 403);
    const client = await db.oauthClient.findUnique({
      where: { clientId: browserClientIdForResourceKey(resource.key) },
    });
    if (!client || client.disabled || client.referenceId !== resource.id)
      throw new WeldallAuthError("invalid_client", "resource or origin is unavailable", 403);
    return Response.json(
      {
        key: resource.key,
        name: resource.name,
        resourceIdentifier: resource.resourceIdentifier,
        authorizationServer: resource.authorizationServer,
        downstreamClientId: resource.downstreamClientId,
        requestPrefixes: resource.requestPrefixes.map(({ urlPrefix }) => urlPrefix),
        supportedScopes: resource.scopes.map(({ scope }) => scope.key).sort(),
        grantedScopes: [],
        browserClientId: client.clientId,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

const handler = withBrowserCors(["GET"], get);
export const GET = withRequestLogging("/api/browser/resources/current", handler);
export const OPTIONS = withRequestLogging("/api/browser/resources/current", handler, {
  successLevel: "debug",
});
