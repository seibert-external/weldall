import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverIssuer,
  normalizeIssuer,
  resolveWeldallConfig,
  selectIssuer,
} from "../src/config.js";
import type { IssuerPreferences } from "../src/storage/preferences.js";

const issuer = "https://weldall.example.com";

const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
  token_endpoint: `${issuer}/api/auth/oauth2/token`,
  revocation_endpoint: `${issuer}/api/auth/oauth2/revoke`,
  jwks_uri: `${issuer}/api/oauth/jwks`,
  scopes_supported: ["openid", "profile", "email", "offline_access", "weldall:scopes"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  dpop_signing_alg_values_supported: ["ES256"],
  authorization_response_iss_parameter_supported: true,
};

const discoveryFetch = (authorizationMetadata: object = metadata) =>
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    return Response.json(
      url.includes("oauth-protected-resource")
        ? { resource: `${issuer}/api`, authorization_servers: [issuer] }
        : authorizationMetadata,
    );
  }) as unknown as typeof fetch;

const memoryPreferences = (initial: string | null = null) => {
  let value = initial;
  const preferences: IssuerPreferences = {
    read: vi.fn(async () => value),
    write: vi.fn(async (issuerValue) => {
      value = issuerValue;
    }),
    clear: vi.fn(async () => {
      value = null;
    }),
  };
  return preferences;
};

afterEach(() => vi.unstubAllEnvs());

describe("issuer configuration", () => {
  it("normalizes hostnames and rejects unsafe issuer URLs", () => {
    expect(normalizeIssuer("weldall.example.com")).toBe(issuer);
    expect(normalizeIssuer(`${issuer}/`)).toBe(issuer);
    for (const value of [
      "http://weldall.example.com",
      `${issuer}/tenant`,
      `${issuer}?tenant=a`,
      "https://user:password@weldall.example.com",
    ])
      expect(() => normalizeIssuer(value)).toThrow();
  });

  it("validates authorization-server and protected-resource discovery", async () => {
    const fetcher = discoveryFetch();
    await expect(discoverIssuer(issuer, { fetcher })).resolves.toEqual({
      issuer,
      resource: `${issuer}/api`,
      authorize: `${issuer}/api/auth/oauth2/authorize`,
      token: `${issuer}/api/auth/oauth2/token`,
      revoke: `${issuer}/api/auth/oauth2/revoke`,
      jwks: `${issuer}/api/oauth/jwks`,
      cli: `${issuer}/api/me/cli`,
      grants: `${issuer}/api/me/grants`,
      scopes: `${issuer}/api/me/scopes`,
      skills: `${issuer}/api/me/skills`,
      userInfo: `${issuer}/api/auth/oauth2/userinfo`,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("strictly discovers the optional browser-connection approval profile", async () => {
    const browserMetadata = {
      ...metadata,
      grant_types_supported: [
        ...metadata.grant_types_supported,
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      device_authorization_endpoint: `${issuer}/api/auth/oauth2/device_authorization`,
      weldall_browser_connections: {
        approval_profile: "cli-code",
        pending_lookup_endpoint: `${issuer}/api/me/browser-connections/pending/lookup`,
        pending_decision_endpoint: `${issuer}/api/me/browser-connections/pending/decision`,
        profile_extensions: ["cli-approval", "initiation-time-dpop-binding"],
      },
    };
    await expect(
      discoverIssuer(issuer, { fetcher: discoveryFetch(browserMetadata) }),
    ).resolves.toEqual(
      expect.objectContaining({
        browserConnections: {
          deviceAuthorization: `${issuer}/api/auth/oauth2/device_authorization`,
          pendingLookup: `${issuer}/api/me/browser-connections/pending/lookup`,
          pendingDecision: `${issuer}/api/me/browser-connections/pending/decision`,
        },
      }),
    );
    await expect(
      discoverIssuer(issuer, {
        fetcher: discoveryFetch({
          ...browserMetadata,
          weldall_browser_connections: {
            ...browserMetadata.weldall_browser_connections,
            pending_lookup_endpoint: "https://attacker.example/lookup",
          },
        }),
      }),
    ).rejects.toThrow("unexpected pending_lookup_endpoint");
  });

  it("rejects discovery documents for a different issuer", async () => {
    await expect(
      discoverIssuer(issuer, {
        fetcher: discoveryFetch({ ...metadata, issuer: "https://attacker.example" }),
      }),
    ).rejects.toThrow("different issuer");
  });

  it("uses WELDALL_ISSUER before the persistent preference", async () => {
    vi.stubEnv("WELDALL_ISSUER", "https://override.example.com");
    const preferences = memoryPreferences(issuer);
    await expect(selectIssuer({ preferences, allowPrompt: false })).resolves.toEqual({
      issuer: "https://override.example.com",
      source: "environment",
    });
    expect(preferences.read).not.toHaveBeenCalled();
  });

  it("uses the persistent preference before prompting", async () => {
    const prompt = vi.fn(async () => "https://prompt.example.com");
    await expect(selectIssuer({ preferences: memoryPreferences(issuer), prompt })).resolves.toEqual(
      {
        issuer,
        source: "preferences",
      },
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts only when environment and persistent preferences are missing", async () => {
    const prompt = vi.fn(async () => "https://prompt.example.com");
    await expect(selectIssuer({ preferences: memoryPreferences(), prompt })).resolves.toEqual({
      issuer: "https://prompt.example.com",
      source: "prompt",
    });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("stores a prompted issuer only after successful discovery", async () => {
    const preferences = memoryPreferences();
    await resolveWeldallConfig({
      preferences,
      prompt: async () => issuer,
      fetcher: discoveryFetch(),
    });
    expect(preferences.write).toHaveBeenCalledWith(issuer);
  });
});
