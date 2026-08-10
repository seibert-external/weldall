import { describe, expect, it } from "vitest";
import { extendOAuthMetadata } from "../src/server/oauth/metadata.js";

describe("OAuth authorization-server workload metadata", () => {
  it("advertises workload authentication while preserving interactive capabilities", () => {
    expect(
      extendOAuthMetadata({
        issuer: "https://weldall.example",
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        dpop_signing_alg_values_supported: ["EdDSA"],
      }),
    ).toMatchObject({
      issuer: "https://weldall.example",
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["ES256"],
      dpop_signing_alg_values_supported: ["EdDSA", "ES256"],
    });
  });
});
