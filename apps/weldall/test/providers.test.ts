import { describe, expect, it } from "vitest";
import { resolveLoginProviders } from "../src/server/auth/providers.js";

const base = { NODE_ENV: "development" } as NodeJS.ProcessEnv;

describe("login provider configuration", () => {
  it("enables Google only when both credentials are present", () => {
    expect(
      resolveLoginProviders({
        ...base,
        GOOGLE_CLIENT_ID: "google-client",
        GOOGLE_CLIENT_SECRET: "google-secret",
      }),
    ).toEqual({
      google: { clientId: "google-client", clientSecret: "google-secret" },
    });
    expect(() => resolveLoginProviders({ ...base, GOOGLE_CLIENT_ID: "google-client" })).toThrow(
      "must be configured together",
    );
  });

  it("treats generated Google placeholders as absent", () => {
    expect(
      resolveLoginProviders({
        ...base,
        GOOGLE_CLIENT_ID: "<<insert or delete line>>",
        GOOGLE_CLIENT_SECRET: "<<insert or delete line>>",
        ENABLE_DEV_LOGIN: "true",
        DEV_IDP_ISSUER: "https://dev-idp.example",
        DEV_IDP_CLIENT_ID: "weldall",
        DEV_IDP_CLIENT_SECRET: "secret",
      }),
    ).toEqual({
      devOidc: {
        issuer: "https://dev-idp.example",
        clientId: "weldall",
        clientSecret: "secret",
      },
    });
  });

  it("enables the development IdP without Google", () => {
    expect(
      resolveLoginProviders({
        ...base,
        ENABLE_DEV_LOGIN: "true",
        DEV_IDP_ISSUER: "https://dev-idp.example",
        DEV_IDP_CLIENT_ID: "weldall",
        DEV_IDP_CLIENT_SECRET: "secret",
      }),
    ).toEqual({
      devOidc: {
        issuer: "https://dev-idp.example",
        clientId: "weldall",
        clientSecret: "secret",
      },
    });
  });

  it("offers Google and the development IdP together in development", () => {
    expect(
      resolveLoginProviders({
        ...base,
        GOOGLE_CLIENT_ID: "google-client",
        GOOGLE_CLIENT_SECRET: "google-secret",
        ENABLE_DEV_LOGIN: "true",
        DEV_IDP_ISSUER: "https://dev-idp.example",
        DEV_IDP_CLIENT_ID: "weldall",
        DEV_IDP_CLIENT_SECRET: "secret",
      }),
    ).toMatchObject({
      google: { clientId: "google-client" },
      devOidc: { issuer: "https://dev-idp.example" },
    });
  });

  it("rejects an issuer URL that would change identity when reduced to an origin", () => {
    expect(() =>
      resolveLoginProviders({
        ...base,
        ENABLE_DEV_LOGIN: "true",
        DEV_IDP_ISSUER: "https://dev-idp.example/tenant-a?profile=test#keys",
        DEV_IDP_CLIENT_ID: "weldall",
        DEV_IDP_CLIENT_SECRET: "secret",
      }),
    ).toThrow("must be an HTTPS origin");
  });

  it("fails closed for development login in production", () => {
    expect(() =>
      resolveLoginProviders({
        NODE_ENV: "development",
        WELDALL_DEPLOYMENT_MODE: "production",
        ENABLE_DEV_LOGIN: "true",
        DEV_IDP_ISSUER: "https://dev-idp.example",
        DEV_IDP_CLIENT_ID: "weldall",
        DEV_IDP_CLIENT_SECRET: "secret",
      }),
    ).toThrow("must not be enabled in production");
  });

  it("fails when no login provider is configured", () => {
    expect(() => resolveLoginProviders(base)).toThrow("at least one login provider");
  });
});
