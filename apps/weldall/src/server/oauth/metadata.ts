import { IAC_SCOPE_KEY } from "@weldall/db";
import { WELDALL_ISSUER } from "./constants";
import { DEVICE_GRANT_TYPE } from "./browser-resources";

export function extendOAuthMetadata(
  metadata: Record<string, unknown>,
  installationId?: string,
): Record<string, unknown> {
  const append = (value: unknown, additions: string[]) => [
    ...new Set([
      ...(Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : []),
      ...additions,
    ]),
  ];
  return {
    ...metadata,
    grant_types_supported: append(metadata.grant_types_supported, [
      "client_credentials",
      DEVICE_GRANT_TYPE,
    ]),
    device_authorization_endpoint: `${WELDALL_ISSUER}/api/auth/oauth2/device_authorization`,
    token_endpoint_auth_methods_supported: append(metadata.token_endpoint_auth_methods_supported, [
      "private_key_jwt",
    ]),
    token_endpoint_auth_signing_alg_values_supported: append(
      metadata.token_endpoint_auth_signing_alg_values_supported,
      ["ES256"],
    ),
    dpop_signing_alg_values_supported: append(metadata.dpop_signing_alg_values_supported, [
      "ES256",
    ]),
    scopes_supported: append(metadata.scopes_supported, [IAC_SCOPE_KEY]),
    weldall_browser_connections: {
      approval_profile: "cli-code",
      pending_lookup_endpoint: `${WELDALL_ISSUER}/api/me/browser-connections/pending/lookup`,
      pending_decision_endpoint: `${WELDALL_ISSUER}/api/me/browser-connections/pending/decision`,
      current_connection_endpoint: `${WELDALL_ISSUER}/api/me/browser-connections/current`,
      revocation_endpoint: `${WELDALL_ISSUER}/api/me/browser-connections/current/revoke`,
      current_status_endpoint: `${WELDALL_ISSUER}/api/me/browser-connections/current`,
      current_revoke_endpoint: `${WELDALL_ISSUER}/api/me/browser-connections/current/revoke`,
      resource_registry_endpoint: `${WELDALL_ISSUER}/api/me/scopes`,
      resource_discovery_endpoint: `${WELDALL_ISSUER}/api/browser/resources/current`,
      profile_extensions: ["cli-approval", "initiation-time-dpop-binding"],
    },
    weldall_iac: {
      endpoint: `${WELDALL_ISSUER}/api/iac/v1`,
      manifestVersions: ["weldall.dev/v1"],
      apiVersions: ["v1"],
      scope: IAC_SCOPE_KEY,
      ...(installationId ? { installationId } : {}),
    },
  };
}
