import { describe, expect, it } from "vitest";
import { extendOAuthMetadata } from "../src/server/oauth/metadata.js";

describe("OAuth authorization-server machine metadata", () => {
  it("advertises machine authentication while preserving interactive capabilities", () => {
    expect(
      extendOAuthMetadata(
        {
          issuer: "https://weldall.example",
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          dpop_signing_alg_values_supported: ["EdDSA"],
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toMatchObject({
      issuer: "https://weldall.example",
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "client_credentials",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      device_authorization_endpoint: expect.stringMatching(
        /\/api\/auth\/oauth2\/device_authorization$/,
      ),
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["ES256"],
      dpop_signing_alg_values_supported: ["EdDSA", "ES256"],
      weldall_browser_connections: {
        approval_profile: "cli-code",
        pending_lookup_endpoint: expect.stringMatching(
          /\/api\/me\/browser-connections\/pending\/lookup$/,
        ),
        pending_decision_endpoint: expect.stringMatching(
          /\/api\/me\/browser-connections\/pending\/decision$/,
        ),
        current_status_endpoint: expect.stringMatching(/\/api\/me\/browser-connections\/current$/),
        current_revoke_endpoint: expect.stringMatching(
          /\/api\/me\/browser-connections\/current\/revoke$/,
        ),
        resource_registry_endpoint: expect.stringMatching(/\/api\/me\/scopes$/),
        resource_discovery_endpoint: expect.stringMatching(/\/api\/browser\/resources\/current$/),
        profile_extensions: ["cli-approval", "initiation-time-dpop-binding"],
      },
      weldall_iac: {
        endpoint: expect.stringMatching(/\/api\/iac\/v1$/),
        manifestVersions: ["weldall.dev/v1"],
        apiVersions: ["v1"],
        scope: "weldall:iac",
        installationId: "00000000-0000-4000-8000-000000000001",
      },
    });
  });
});
