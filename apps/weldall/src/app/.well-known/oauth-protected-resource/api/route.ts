import { WELDALL_ISSUER, WELDALL_RESOURCE } from "@/server/oauth/constants";
import { withRequestLogging } from "@/server/observability/http";
import { withBrowserCors } from "@/server/oauth/browser-cors";

function get() {
  return Response.json({
    resource: WELDALL_RESOURCE,
    authorization_servers: [WELDALL_ISSUER],
    scopes_supported: ["weldall:scopes"],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: ["ES256"],
  });
}

const handler = withBrowserCors(["GET"], get);
export const GET = withRequestLogging("/.well-known/oauth-protected-resource/api", handler, {
  successLevel: "debug",
});
export const OPTIONS = withRequestLogging("/.well-known/oauth-protected-resource/api", handler, {
  successLevel: "debug",
});
