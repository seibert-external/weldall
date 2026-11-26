import { describe, expect, it } from "vitest";
import { providerConfigSchema } from "../src/server/auth/oidc-config";
import {
  entraOidcIdentityVerifier,
  identityVerifierForIssuer,
  standardOidcIdentityVerifier,
} from "../src/server/auth/oidc-identity";

const config = {
  name: "Company",
  buttonLabel: "Sign in",
  buttonColor: "#ffffff",
  issuer: "https://id.example.com/tenant/",
  clientId: "client",
  clientSecret: "secret",
  tokenEndpointAuthMethod: "client_secret_post" as const,
};
const tenant = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
describe("standard OIDC identity verifier", () => {
  const provider = providerConfigSchema.parse({ ...config, allowedEmailDomains: ["EXAMPLE.COM"] });
  const verify = (claims: Record<string, unknown>) =>
    standardOidcIdentityVerifier.verifyIdentity(claims, provider);
  it("requires boolean verification and exact normalized domain every time", () => {
    expect(verify({ sub: "subject", email: "Alice@Example.com", email_verified: true })).toEqual({
      issuer: provider.issuer,
      subject: "subject",
      email: "alice@example.com",
      name: "alice@example.com",
    });
    for (const verification of [false, "true", 1, undefined])
      expect(() =>
        verify({ sub: "s", email: "alice@example.com", email_verified: verification }),
      ).toThrow("unverified_identity");
    expect(() => verify({ sub: "s", email: "a@sub.example.com", email_verified: true })).toThrow(
      "email_domain_denied",
    );
  });
  it("checks verification before identity claims and identity claims before domains", () => {
    expect(() => verify({ sub: "", email: "a@other.example", email_verified: false })).toThrow(
      "unverified_identity",
    );
    expect(() => verify({ sub: "", email: "a@other.example", email_verified: true })).toThrow(
      "unverified_identity",
    );
  });
});
describe("identity verifier selection", () => {
  it("selects the Entra verifier for a tenant-bound Entra v2.0 issuer", () =>
    expect(identityVerifierForIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)).toBe(
      entraOidcIdentityVerifier,
    ));
  it.each([
    config.issuer,
    "https://login.microsoftonline.com/common/v2.0",
    "https://login.microsoftonline.com/organizations/v2.0",
    "https://login.microsoftonline.com/consumers/v2.0",
    `https://sts.windows.net/${tenant}/`,
    `https://login.microsoftonline.com.evil.example/${tenant}/v2.0`,
    `https://login.microsoftonline.com/${tenant.toUpperCase()}/v2.0`,
    `https://login.microsoftonline.com/${tenant}`,
    `https://login.microsoftonline.com/${tenant}/v2.0/`,
  ])("treats look-alike issuer %s as generic OIDC", (issuer) => {
    expect(identityVerifierForIssuer(issuer)).toBe(standardOidcIdentityVerifier);
    const lookAlike = providerConfigSchema.parse({ ...config, issuer });
    const member = {
      sub: "entra-sub",
      email: "Alice@Example.com",
      tid: tenant,
      xms_edov: true,
      acct: 0,
    };
    const verifier = identityVerifierForIssuer(issuer);
    expect(() => verifier.verifyIdentity(member, lookAlike)).toThrow("unverified_identity");
    expect(verifier.verifyIdentity({ ...member, email_verified: true }, lookAlike).email).toBe(
      "alice@example.com",
    );
  });
});
