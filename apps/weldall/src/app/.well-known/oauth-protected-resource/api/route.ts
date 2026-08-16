import { WELDALL_ISSUER, WELDALL_RESOURCE } from "@/server/oauth/constants";
import { withRequestLogging } from "@/server/observability/http";

function get() {
  return Response.json({
    resource: WELDALL_RESOURCE,
    authorization_servers: [WELDALL_ISSUER],
    scopes_supported: ["weldall:scopes"],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: ["ES256"],
  });
}

export const GET = withRequestLogging("/.well-known/oauth-protected-resource/api", get, {
  successLevel: "debug",
});
