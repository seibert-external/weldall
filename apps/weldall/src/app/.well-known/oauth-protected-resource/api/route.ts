import { WELDALL_ISSUER, WELDALL_RESOURCE } from "@weldall/oauth";

export function GET() {
  return Response.json({
    resource: WELDALL_RESOURCE,
    authorization_servers: [WELDALL_ISSUER],
    scopes_supported: ["weldall:scopes"],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: ["ES256"],
  });
}
