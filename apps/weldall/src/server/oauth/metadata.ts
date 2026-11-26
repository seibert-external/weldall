import { IAC_SCOPE_KEY, SUBJECT_SCOPES_CHECK_SCOPE_KEY } from "@weldall/db";
import { WELDALL_ISSUER } from "./constants";

// The provider advertises these even though Weldall does not expose the endpoints.
export function publicDiscoveryMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => key !== "end_session_endpoint" && !key.startsWith("introspection_endpoint"),
    ),
  );
}

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
    ...publicDiscoveryMetadata(metadata),
    grant_types_supported: append(metadata.grant_types_supported, ["client_credentials"]),
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
    scopes_supported: append(metadata.scopes_supported, [
      IAC_SCOPE_KEY,
      SUBJECT_SCOPES_CHECK_SCOPE_KEY,
    ]),
    weldall_subject_scope_check: {
      endpoint: `${WELDALL_ISSUER}/api/authorization/v1/check-scopes`,
      scope: SUBJECT_SCOPES_CHECK_SCOPE_KEY,
    },
    weldall_iac: {
      endpoint: `${WELDALL_ISSUER}/api/iac/v1`,
      manifestVersions: ["weldall.dev/v1"],
      apiVersions: ["v1"],
      features: ["mcp", "mcp-discovery-v1", "iac-ui-secrets-v1"],
      scope: IAC_SCOPE_KEY,
      ...(installationId ? { installationId } : {}),
    },
  };
}
