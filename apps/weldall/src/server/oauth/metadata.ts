import { IAC_SCOPE_KEY } from "@weldall/db";
import { WELDALL_ISSUER } from "./constants";

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
    scopes_supported: append(metadata.scopes_supported, [IAC_SCOPE_KEY]),
    weldall_iac: {
      endpoint: `${WELDALL_ISSUER}/api/iac/v1`,
      manifestVersions: ["weldall.dev/v1alpha1"],
      apiVersions: ["v1"],
      scope: IAC_SCOPE_KEY,
      ...(installationId ? { installationId } : {}),
    },
  };
}
