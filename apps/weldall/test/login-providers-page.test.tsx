import { describe, expect, it } from "vitest";
import {
  buildBody,
  validateClientSecret,
  validateSortOrder,
  type FormValues,
} from "../src/app/admin/login-providers/oidc-admin-api";

const draft = {
  providerId: "00000000-0000-4000-8000-000000000001",
  callbackUrl: "https://weldall.example.com/api/auth/callback/00000000-0000-4000-8000-000000000001",
  expectedVersion: 3,
};

const values: FormValues = {
  name: "Company",
  buttonLabel: "Continue with SSO",
  buttonColor: "#2563eb",
  sortOrder: "10",
  issuer: "https://identity.example.com/tenant/",
  discoveryUrl: "https://identity.example.com/.well-known/openid-configuration",
  clientId: "weldall",
  clientSecret: "provider-secret",
  tokenEndpointAuthMethod: "client_secret_post",
  scopes: "openid  profile  email",
  domains: "example.com, weldall.example.com",
  enabled: true,
  acknowledgeAuthority: true,
  acknowledgeLockout: false,
};

describe("login provider form wire contract", () => {
  it("serializes form values into the admin-save body", () => {
    expect(buildBody(draft, values)).toEqual({
      providerId: draft.providerId,
      expectedVersion: 3,
      enabled: true,
      acknowledgeAuthority: true,
      acknowledgeLockout: false,
      config: {
        name: "Company",
        buttonLabel: "Continue with SSO",
        buttonColor: "#2563eb",
        sortOrder: 10,
        issuer: "https://identity.example.com/tenant/",
        discoveryUrl: "https://identity.example.com/.well-known/openid-configuration",
        clientId: "weldall",
        clientSecret: "provider-secret",
        tokenEndpointAuthMethod: "client_secret_post",
        scopes: ["openid", "profile", "email"],
        allowedEmailDomains: ["example.com", "weldall.example.com"],
      },
    });
  });
  it("omits an empty discovery URL, client secret, and blank domains", () => {
    const body = buildBody(draft, {
      ...values,
      discoveryUrl: "",
      clientSecret: "",
      domains: "   ",
    });
    expect(body.config).not.toHaveProperty("discoveryUrl");
    expect(body.config).not.toHaveProperty("clientSecret");
    expect(body.config.allowedEmailDomains).toEqual([]);
    expect(body.config.scopes).toEqual(["openid", "profile", "email"]);
  });
});

describe("login provider form validators", () => {
  it.each([
    [{ value: "" }, "Order is required."],
    [{ value: "1.5" }, "Order must be an integer between -10000 and 10000."],
    [{ value: "-10001" }, "Order must be an integer between -10000 and 10000."],
    [{ value: "10001" }, "Order must be an integer between -10000 and 10000."],
    [{ value: "abc" }, "Order must be an integer between -10000 and 10000."],
    [{ value: 0 }, undefined],
    [{ value: "0" }, undefined],
  ])("sortOrder %j passes %s", ({ value }, expected) => {
    // TanStack Form calls field validator functions with a { value, fieldApi } props
    // object — never a raw value. Passing a raw-value function here breaks silently,
    // so the props-object call is the contract we test.
    expect(validateSortOrder({ value })).toBe(expected);
  });
  it.each([["0"], ["-10000"], ["10000"], [" 7 "], [0]])("accepts sortOrder %s", (value) => {
    expect(validateSortOrder({ value })).toBeUndefined();
  });
  it("requires a client secret for new providers and trims length", () => {
    expect(validateClientSecret("", false)).toBe("Client secret is required.");
    expect(validateClientSecret("", true)).toBeUndefined();
    expect(validateClientSecret("x".repeat(4096), true)).toBeUndefined();
    expect(validateClientSecret("x".repeat(4097), true)).toBe(
      "Client secret must be 4096 characters or less.",
    );
  });
});
