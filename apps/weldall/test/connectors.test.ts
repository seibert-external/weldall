import { afterEach, describe, expect, it, vi } from "vitest";
import { sealConnectorValue, unsealConnectorValue } from "../src/server/connectors/credentials.js";
import { googleConnector, testGoogleConfiguration } from "../src/server/connectors/google.js";
import { allowedTargetPrefixes, targetAllowed } from "../src/server/connectors/registry.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("connector registry", () => {
  it("exposes only fixed Gmail and Calendar targets", () => {
    expect(allowedTargetPrefixes(["gmail", "calendar"])).toEqual([
      "https://gmail.googleapis.com/gmail/v1/",
      "https://www.googleapis.com/calendar/v3/",
    ]);
    expect(
      targetAllowed(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10",
        ["calendar"],
      )?.hostname,
    ).toBe("www.googleapis.com");
  });

  it.each([
    "http://www.googleapis.com/calendar/v3/calendars/primary/events",
    "https://www.googleapis.com.evil.example/calendar/v3/calendars/primary/events",
    "https://www.googleapis.com/calendar/v30/events",
    "https://user@www.googleapis.com/calendar/v3/events",
    "https://www.googleapis.com:444/calendar/v3/events",
    "https://www.googleapis.com/calendar/v3/events#token",
  ])("rejects unsafe target %s", (target) => {
    expect(targetAllowed(target, ["calendar"])).toBeNull();
  });
});

describe("Google connector configuration", () => {
  it("validates configured API scopes and creates a PKCE authorization URL", async () => {
    const config = await googleConnector.validateConfig({
      clientId: "google-client",
      clientSecret: "google-secret",
      enabledApis: ["calendar"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const { url } = await googleConnector.startAuthorization({
      config,
      redirectUri: "https://weldall.example.com/api/connectors/google/callback",
      state: "state-value",
      nonce: "nonce-value",
      codeChallenge: "challenge-value",
    });
    const authorization = new URL(url);

    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("state")).toBe("state-value");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(url).not.toContain("google-secret");
  });

  it("tests only Google's fixed discovery endpoint without sending client secrets", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(testGoogleConfiguration()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "https://accounts.google.com/.well-known/openid-configuration",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("client");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("secret");
  });

  it("rejects scopes for disabled APIs", async () => {
    await expect(
      googleConnector.validateConfig({
        clientId: "google-client",
        clientSecret: "google-secret",
        enabledApis: ["calendar"],
        oauthScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      }),
    ).rejects.toThrow();
  });
});

describe("connector secret encryption", () => {
  it("binds ciphertext to its purpose and row", () => {
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const encrypted = sealConnectorValue("connector-config", "connector-a", "secret-value");

    expect(encrypted).not.toContain("secret-value");
    expect(unsealConnectorValue("connector-config", "connector-a", encrypted)).toBe("secret-value");
    expect(() => unsealConnectorValue("connector-config", "connector-b", encrypted)).toThrow(
      "unavailable",
    );
    expect(() => unsealConnectorValue("handoff", "connector-a", encrypted)).toThrow("unavailable");
  });
});
