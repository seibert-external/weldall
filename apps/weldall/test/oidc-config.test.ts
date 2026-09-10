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
import { decryptChatApiKey, encryptChatApiKey } from "../src/server/ai/credentials";
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
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION", "1");
  const oidc = seal("provider", "one", "oidc-secret");
  const attempt = seal("attempt", "one", "transient-secret");
  const group = { id: "one", ...encryptProviderToken("one", "group-token") };
  const chat = { id: "one", ...encryptChatApiKey("one", "chat-key") };
  expect(unseal("provider", "one", oidc)).toBe("oidc-secret");
  expect(unseal("attempt", "one", attempt)).toBe("transient-secret");
  expect(decryptProviderToken(group)).toBe("group-token");
  expect(decryptChatApiKey(chat)).toBe("chat-key");
  expect(() => unseal("provider", "one", attempt)).toThrow();
  expect(() => unseal("provider", "one", group.encryptedToken)).toThrow();
  expect(() => unseal("attempt", "one", chat.encryptedApiKey)).toThrow();
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
  expect(() => unseal("provider", "one", oidc)).toThrow("credential_unavailable");
  expect(() => unseal("attempt", "one", attempt)).toThrow("credential_unavailable");
});
