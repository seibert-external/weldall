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
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["ES256"],
      dpop_signing_alg_values_supported: ["EdDSA", "ES256"],
      scopes_supported: ["weldall:iac", "weldall:subject-scopes-check"],
      weldall_subject_scope_check: {
        endpoint: expect.stringMatching(/\/api\/authorization\/v1\/check-scopes$/),
        scope: "weldall:subject-scopes-check",
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
