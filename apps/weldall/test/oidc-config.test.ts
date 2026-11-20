import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buttonForeground,
  emailSchema,
  discoveryUrl,
  providerConfigSchema,
  verifiedIdentity,
} from "../src/server/auth/oidc-config";
import { requireSetupToken, seal, unseal } from "../src/server/auth/oidc-credentials";
import {
  decryptProviderToken,
  encryptProviderToken,
} from "../src/server/group-providers/credentials";
export const config = {
  name: "Company",
  buttonLabel: "Sign in",
  buttonColor: "#ffffff",
  issuer: "https://id.example.com/tenant/",
  clientId: "client",
  clientSecret: "secret",
  tokenEndpointAuthMethod: "client_secret_post" as const,
};
afterEach(() => vi.unstubAllEnvs());
describe("OIDC config", () => {
  it("canonicalizes accepted emails to ASCII including the Kelvin lowercase mapping", () => {
    expect(emailSchema.parse("KATE@EXAMPLE.COM")).toBe("kate@example.com");
    expect(emailSchema.safeParse("üser@example.com").success).toBe(false);
  });
  it("preserves exact issuer and derives path discovery", () => {
    const parsed = providerConfigSchema.parse(config);
    expect(parsed.issuer).toBe(config.issuer);
    expect(discoveryUrl(parsed)).toBe(
      "https://id.example.com/tenant/.well-known/openid-configuration",
    );
    expect(discoveryUrl({ ...parsed, discoveryUrl: "https://metadata.example.com/config" })).toBe(
      "https://metadata.example.com/config",
    );
    expect(
      providerConfigSchema.parse({
        ...config,
        discoveryUrl: "https://metadata.example.com/config?tenant=one",
      }).discoveryUrl,
    ).toBe("https://metadata.example.com/config?tenant=one");
    expect(buttonForeground("#ffffff")).toBe("#000000");
    expect(buttonForeground("#000000")).toBe("#ffffff");
  });
  it.each([
    { issuer: "http://example.com" },
    { issuer: "https://u:p@example.com" },
    { issuer: "https://example.com?a=1" },
    { buttonColor: "red" },
    { scopes: ["openid", "email", "offline_access"] },
    { scopes: ["openid"] },
    { clientSecret: "" },
    { allowedEmailDomains: ["*.example.com"] },
  ])("rejects invalid config %j", (patch) =>
    expect(providerConfigSchema.safeParse({ ...config, ...patch }).success).toBe(false),
  );
  it("requires boolean verification and exact normalized domain every time", () => {
    const provider = providerConfigSchema.parse({
      ...config,
      allowedEmailDomains: ["EXAMPLE.COM"],
    });
    expect(
      verifiedIdentity(
        { sub: "subject", email: "Alice@Example.com", email_verified: true },
        provider,
      ).email,
    ).toBe("alice@example.com");
    for (const verification of [false, "true", 1, undefined])
      expect(() =>
        verifiedIdentity(
          { sub: "s", email: "alice@example.com", email_verified: verification },
          provider,
        ),
      ).toThrow("unverified_identity");
    expect(() =>
      verifiedIdentity({ sub: "s", email: "a@sub.example.com", email_verified: true }, provider),
    ).toThrow("email_domain_denied");
  });
});
describe("Entra ID identities", () => {
  const tenant = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const otherTenant = "fedcba98-7654-4321-8fed-cba987654321";
  const provider = providerConfigSchema.parse({
    ...config,
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    allowedEmailDomains: ["example.com"],
  });
  const member = {
    sub: "entra-sub",
    email: "Alice@Example.com",
    tid: tenant,
    xms_edov: true,
    acct: 0,
  };
  it("accepts a tenant member with a verified email", () =>
    expect(verifiedIdentity(member, provider)).toEqual({
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
    expect(verifiedIdentity({ ...member, ...patch }, provider).subject).toBe("entra-sub"),
  );
  it("rejects a missing acct claim as a configuration error", () =>
    expect(() => verifiedIdentity({ ...member, acct: undefined }, provider)).toThrow(
      "entra_claims_missing",
    ));
  it.each([undefined, false, "true", 1, null])("rejects xms_edov %j", (xms_edov) =>
    expect(() => verifiedIdentity({ ...member, xms_edov }, provider)).toThrow(
      "entra_email_unverified",
    ),
  );
  it("does not accept email_verified in place of xms_edov", () =>
    expect(() =>
      verifiedIdentity({ ...member, xms_edov: undefined, email_verified: true }, provider),
    ).toThrow("entra_email_unverified"));
  it.each([undefined, otherTenant, tenant.toUpperCase(), 1])("rejects tid %j", (tid) =>
    expect(() => verifiedIdentity({ ...member, tid }, provider)).toThrow("unverified_identity"),
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
    expect(() => verifiedIdentity({ ...member, ...guest }, provider)).toThrow("entra_guest_denied"),
  );
  it.each([{ email: undefined }, { email: "not-an-email" }, { sub: "" }])(
    "rejects missing identity claims %j",
    (patch) =>
      expect(() => verifiedIdentity({ ...member, ...patch }, provider)).toThrow(
        "unverified_identity",
      ),
  );
  it("still enforces allowed email domains", () =>
    expect(() => verifiedIdentity({ ...member, email: "a@other.example" }, provider)).toThrow(
      "email_domain_denied",
    ));
  it.each([
    "https://login.microsoftonline.com/common/v2.0",
    "https://login.microsoftonline.com/organizations/v2.0",
    "https://login.microsoftonline.com/consumers/v2.0",
    `https://sts.windows.net/${tenant}/`,
    `https://login.microsoftonline.com.evil.example/${tenant}/v2.0`,
    `https://login.microsoftonline.com/${tenant.toUpperCase()}/v2.0`,
    `https://login.microsoftonline.com/${tenant}`,
    `https://login.microsoftonline.com/${tenant}/v2.0/`,
  ])("treats look-alike issuer %s as generic OIDC", (issuer) => {
    const lookAlike = providerConfigSchema.parse({ ...config, issuer });
    expect(() => verifiedIdentity(member, lookAlike)).toThrow("unverified_identity");
    expect(verifiedIdentity({ ...member, email_verified: true }, lookAlike).email).toBe(
      "alice@example.com",
    );
  });
});
it("encrypts with purpose and identity binding and protects setup token", () => {
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
  const encrypted = seal("provider", "one", "secret");
  expect(encrypted).not.toContain("secret");
  expect(unseal("provider", "one", encrypted)).toBe("secret");
  expect(() => unseal("provider", "two", encrypted)).toThrow();
  expect(() => unseal("attempt", "one", encrypted)).toThrow();
  vi.stubEnv("WELDALL_SETUP_TOKEN", "a".repeat(43));
  expect(() => requireSetupToken("a".repeat(43))).not.toThrow();
  expect(() => requireSetupToken("b".repeat(43))).toThrow("setup_unauthorized");
});
it("shares the credential key without mixing credential purposes", () => {
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
  const oidc = seal("provider", "one", "oidc-secret");
  const attempt = seal("attempt", "one", "transient-secret");
  const group = { id: "one", ...encryptProviderToken("one", "group-token") };
  expect(unseal("provider", "one", oidc)).toBe("oidc-secret");
  expect(unseal("attempt", "one", attempt)).toBe("transient-secret");
  expect(decryptProviderToken(group)).toBe("group-token");
  expect(() => unseal("provider", "one", attempt)).toThrow();
  expect(() => unseal("provider", "one", group.encryptedToken)).toThrow();
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
  expect(() => unseal("provider", "one", oidc)).toThrow("credential_unavailable");
  expect(() => unseal("attempt", "one", attempt)).toThrow("credential_unavailable");
});
