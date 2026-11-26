import { describe, expect, it } from "vitest";
import { providerConfigSchema } from "../src/server/auth/oidc-config";
import { assertEntraIdentityClaims, isTenantBoundEntraIssuer } from "../src/server/auth/oidc-entra";
import { entraOidcIdentityVerifier } from "../src/server/auth/oidc-identity";

const tenant = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const otherTenant = "fedcba98-7654-4321-8fed-cba987654321";
const config = {
  name: "Company",
  buttonLabel: "Sign in",
  buttonColor: "#ffffff",
  issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
  clientId: "client",
  clientSecret: "secret",
  tokenEndpointAuthMethod: "client_secret_post" as const,
};
describe("Entra ID identities", () => {
  const provider = providerConfigSchema.parse({ ...config, allowedEmailDomains: ["example.com"] });
  const verify = (claims: Record<string, unknown>) =>
    entraOidcIdentityVerifier.verifyIdentity(claims, provider);
  const member = {
    sub: "entra-sub",
    email: "Alice@Example.com",
    tid: tenant,
    xms_edov: true,
    acct: 0,
  };
  it("recognizes only the exact tenant-bound v2.0 issuer", () => {
    expect(isTenantBoundEntraIssuer(provider.issuer)).toBe(true);
    expect(isTenantBoundEntraIssuer(`https://login.microsoftonline.com/${tenant}/v2.0/`)).toBe(
      false,
    );
  });
  it("accepts a tenant member with a verified email", () =>
    expect(verify(member)).toEqual({
      issuer: provider.issuer,
      subject: "entra-sub",
      email: "alice@example.com",
      name: "alice@example.com",
    }));
  it.each([
    ["no idp", {}],
    ["idp equal to the issuer", { idp: `https://login.microsoftonline.com/${tenant}/v2.0` }],
    ["idp in the v1 sts form", { idp: `https://sts.windows.net/${tenant}/` }],
    ["email_verified false ignored", { email_verified: false }],
  ])("accepts a member with %s", (_, patch) =>
    expect(verify({ ...member, ...patch }).subject).toBe("entra-sub"),
  );
  it("rejects a missing acct claim as a configuration error", () =>
    expect(() => verify({ ...member, acct: undefined })).toThrow("entra_claims_missing"));
  it.each([undefined, false, "true", 1, null])("rejects xms_edov %j", (xms_edov) =>
    expect(() => verify({ ...member, xms_edov })).toThrow("entra_email_unverified"),
  );
  it("does not accept email_verified in place of xms_edov", () =>
    expect(() => verify({ ...member, xms_edov: undefined, email_verified: true })).toThrow(
      "entra_email_unverified",
    ));
  it.each([undefined, otherTenant, tenant.toUpperCase(), 1])("rejects tid %j", (tid) =>
    expect(() => verify({ ...member, tid })).toThrow("unverified_identity"),
  );
  it.each([
    { acct: 1 },
    { acct: "1" },
    { acct: true },
    { acct: null },
    { idp: `https://sts.windows.net/${otherTenant}/` },
    { idp: `https://evil.example/${tenant}/` },
    { idp: `https://sts.windows.net/${tenant}` },
    { idp: tenant },
    { idp: "live.com" },
    { idp: "google.com" },
    { idp: "" },
    { idp: 1 },
    { idp: null },
    { idp: [tenant] },
  ])("rejects guest %j", (guest) =>
    expect(() => verify({ ...member, ...guest })).toThrow("entra_guest_denied"),
  );
  it.each([{ email: undefined }, { email: "not-an-email" }, { sub: "" }])(
    "rejects missing identity claims %j",
    (patch) => expect(() => verify({ ...member, ...patch })).toThrow("unverified_identity"),
  );
  it("still enforces allowed email domains", () =>
    expect(() => verify({ ...member, email: "a@other.example" })).toThrow("email_domain_denied"));
  it("reports the first failing check: tid, acct, guest, xms_edov, identity, domain", () => {
    const broken = { ...member, sub: "", email: "a@other.example", xms_edov: false, acct: 1 };
    expect(() => verify({ ...broken, tid: otherTenant })).toThrow("unverified_identity");
    expect(() => verify({ ...broken, acct: undefined })).toThrow("entra_claims_missing");
    expect(() => verify(broken)).toThrow("entra_guest_denied");
    expect(() => verify({ ...broken, acct: 0 })).toThrow("entra_email_unverified");
    expect(() => verify({ ...broken, acct: 0, xms_edov: true })).toThrow("unverified_identity");
    expect(() => verify({ ...broken, acct: 0, xms_edov: true, sub: "s" })).toThrow(
      "email_domain_denied",
    );
  });
  it("fails closed when asked to check claims for a non-Entra issuer", () => {
    const generic = providerConfigSchema.parse({ ...config, issuer: "https://id.example.com/" });
    expect(() => assertEntraIdentityClaims({ ...member, tid: undefined }, generic)).toThrow(
      "unverified_identity",
    );
  });
});
