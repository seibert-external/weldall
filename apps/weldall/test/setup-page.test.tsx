import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initialProviderId = "00000000-0000-4000-8000-000000000001";
const callback = `https://weldall.seibert.localdev/api/auth/callback/${initialProviderId}`;
const mocks = vi.hoisted(() => ({
  installationCompleted: vi.fn(),
  redirect: vi.fn(),
  firstProviderId: vi.fn(),
}));
vi.mock("../src/server/auth/login-service", () => ({
  installationCompleted: mocks.installationCompleted,
  firstProviderId: mocks.firstProviderId,
  callbackUrl: (id: string) => `https://weldall.seibert.localdev/api/auth/callback/${id}`,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import Setup from "../src/app/setup/page";
import { setupConfigurationIssues } from "../src/server/auth/oidc-credentials";
import {
  setupFieldSchemas,
  setupFormDefaults,
  setupFormSchema,
} from "../src/app/setup/setup-form-schema";

const token = "t".repeat(43);
const key = Buffer.alloc(32, 7).toString("base64");
beforeEach(() => {
  mocks.installationCompleted.mockReset().mockResolvedValue(false);
  mocks.firstProviderId.mockReset().mockReturnValue(initialProviderId);
  mocks.redirect.mockReset().mockImplementation(() => {
    throw new Error("redirect");
  });
  vi.stubEnv("WELDALL_SETUP_TOKEN", token);
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", key);
});
afterEach(() => vi.unstubAllEnvs());

describe("installer configuration gate", () => {
  it.each([undefined, "", "short", "x".repeat(129)])(
    "blocks a missing/malformed setup token (%s)",
    async (value) => {
      vi.stubEnv("WELDALL_SETUP_TOKEN", value);
      expect(setupConfigurationIssues()).toEqual(["WELDALL_SETUP_TOKEN"]);
      const html = renderToStaticMarkup(await Setup());
      expect(html).toContain("Setup requires server configuration");
      expect(html).toContain("WELDALL_SETUP_TOKEN");
      expect(html).toContain("restart Weldall");
      expect(html).toContain('alt="Weldall"');
      expect(html).not.toContain("<form");
      expect(html).not.toContain(key);
    },
  );
  it.each([undefined, "", "not-base64", Buffer.alloc(31).toString("base64"), `${key}\n`])(
    "blocks a missing/malformed encryption key (%s)",
    async (value) => {
      vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", value);
      expect(setupConfigurationIssues()).toEqual(["WELDALL_CREDENTIAL_ENCRYPTION_KEY"]);
      const html = renderToStaticMarkup(await Setup());
      expect(html).toContain("WELDALL_CREDENTIAL_ENCRYPTION_KEY");
      expect(html).not.toContain("<form");
      expect(html).not.toContain(token);
    },
  );
  it("reports both invalid keys without exposing their values", async () => {
    vi.stubEnv("WELDALL_SETUP_TOKEN", "invalid-sensitive-token");
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", "invalid-sensitive-key");
    expect(setupConfigurationIssues()).toEqual([
      "WELDALL_SETUP_TOKEN",
      "WELDALL_CREDENTIAL_ENCRYPTION_KEY",
    ]);
    const html = renderToStaticMarkup(await Setup());
    expect(html).not.toContain("invalid-sensitive");
  });
  it("renders the branded form only when configured, without embedding server secrets", async () => {
    expect(setupConfigurationIssues()).toEqual([]);
    const html = renderToStaticMarkup(await Setup());
    expect(html).toContain('alt="Weldall"');
    expect(html).toContain("<form");
    expect(html).toContain("Operator setup token");
    expect(html).toContain("Test login (optional)");
    expect(html).toContain("Complete installation");
    expect(html).not.toContain("Test login and complete installation");
    expect(html).toContain(callback);
    expect(html).not.toContain("Loading…");
    expect(renderToStaticMarkup(await Setup())).toContain(callback);
    expect(html).toContain('type="password"');
    expect(html).not.toContain(token);
    expect(html).not.toContain(key);
    expect(html.indexOf('alt="Weldall"')).toBeLessThan(html.indexOf("<form"));
  });
  it("keeps completed setup closed even after removing setup secrets", async () => {
    mocks.installationCompleted.mockResolvedValue(true);
    vi.stubEnv("WELDALL_SETUP_TOKEN", undefined);
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", undefined);
    await expect(Setup()).rejects.toThrow("redirect");
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });
  it("does not turn database failures into an open installer", async () => {
    mocks.installationCompleted.mockRejectedValue(new Error("database unavailable"));
    await expect(Setup()).rejects.toThrow("database unavailable");
  });
});

const validForm = {
  ...setupFormDefaults,
  token,
  adminEmail: "Alice@Example.com",
  name: "Company",
  issuer: "https://identity.example.com/tenant/",
  clientId: "weldall",
  clientSecret: "provider-secret",
  acknowledgeAuthority: true,
};
describe("TanStack setup form validation", () => {
  it("validates form values against the OIDC contract", () => {
    expect(setupFormSchema.parse(validForm).adminEmail).toBe("alice@example.com");
  });
  it.each([
    ["token", ""],
    ["adminEmail", "not-email"],
    ["name", ""],
    ["clientSecret", ""],
    ["buttonColor", "red"],
    ["issuer", "http://example.com"],
    ["issuer", "https://example.com?query=1"],
    ["discoveryUrl", "https://user:password@example.com"],
    ["scopes", "openid offline_access"],
    ["domains", "*.example.com"],
    ["acknowledgeAuthority", false],
  ])("reports invalid %s at the corresponding field", (name, value) => {
    const result = setupFormSchema.safeParse({ ...validForm, [name]: value });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.path[0] === name)).toBe(true);
  });
});

describe("per-field setup validators", () => {
  it.each([
    ["token", "t".repeat(43), true],
    ["token", "", false],
    ["token", "t".repeat(42), false],
    ["adminEmail", "alice@example.com", true],
    ["adminEmail", "a", false],
    ["name", "Company", true],
    ["name", "", false],
    ["buttonColor", "#2563eb", true],
    ["buttonColor", "red", false],
    ["issuer", "https://identity.example.com", true],
    ["issuer", "http://example.com", false],
    ["discoveryUrl", "", true],
    ["discoveryUrl", "https://identity.example.com/.well-known/openid-configuration", true],
    ["discoveryUrl", "https://user:password@example.com", false],
    ["clientId", "weldall", true],
    ["clientId", "", false],
    ["clientSecret", "provider-secret", true],
    ["clientSecret", "", false],
    ["tokenEndpointAuthMethod", "client_secret_basic", true],
    ["tokenEndpointAuthMethod", "client_secret_bogus", false],
    ["scopes", "openid profile email", true],
    ["scopes", "openid offline_access", false],
    ["domains", "", true],
    ["domains", "example.com", true],
    ["domains", "*.example.com", false],
    ["acknowledgeAuthority", true, true],
    ["acknowledgeAuthority", false, false],
  ] as const)("%s=%s accepts=%s", (name, value, accepts) => {
    const schema = setupFieldSchemas[name];
    expect(schema.safeParse(value).success).toBe(accepts);
  });
});
