import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { providerConfigSchema } from "../src/server/auth/oidc-config";
const transport = vi.hoisted(() => vi.fn());
vi.mock("../src/server/auth/oidc-transport", () => ({ oidcJson: transport }));
import { authorizationUrl, discover, exchange } from "../src/server/auth/oidc-runtime";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
let serial = 0;
const config = (method: "client_secret_post" | "client_secret_basic" = "client_secret_post") =>
  providerConfigSchema.parse({
    name: "OIDC",
    buttonLabel: "OIDC",
    buttonColor: "#123456",
    issuer: `https://id${serial++}.example.com/tenant`,
    clientId: "client",
    clientSecret: "secret",
    tokenEndpointAuthMethod: method,
  });
beforeAll(async () => {
  keys = await generateKeyPair("ES256", { extractable: true });
  jwk = await exportJWK(keys.publicKey);
});
beforeEach(() => {
  transport.mockReset();
});
async function upstream(
  input: {
    metadata?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    token?: string;
    userinfo?: Record<string, unknown>;
    method?: "client_secret_post" | "client_secret_basic";
  } = {},
) {
  const provider = config(input.method);
  const now = Math.floor(Date.now() / 1000);
  const token =
    input.token ??
    (await new SignJWT({
      iss: provider.issuer,
      aud: provider.clientId,
      sub: "subject",
      exp: now + 300,
      iat: now,
      nonce: "nonce",
      email: "alice@example.com",
      email_verified: true,
      ...input.claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .sign(keys.privateKey));
  transport.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("openid-configuration"))
      return {
        issuer: provider.issuer,
        authorization_endpoint: `${provider.issuer}/authorize`,
        token_endpoint: `${provider.issuer}/token`,
        jwks_uri: `${provider.issuer}/jwks`,
        userinfo_endpoint: `${provider.issuer}/userinfo`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: [provider.tokenEndpointAuthMethod],
        code_challenge_methods_supported: ["S256"],
        ...input.metadata,
      };
    if (path.endsWith("/jwks")) return { keys: [{ ...jwk, kid: "test", alg: "ES256" }] };
    if (path.endsWith("/token")) return { id_token: token, access_token: "upstream-access-token" };
    if (path.endsWith("/userinfo")) return input.userinfo ?? { sub: "subject" };
    throw new Error("unexpected endpoint");
  });
  return provider;
}
const run = (provider: ReturnType<typeof config>) =>
  exchange(
    provider,
    "https://weldall.example.com/api/auth/callback/id",
    "code",
    "nonce",
    "v".repeat(43),
  );
describe("OIDC current signed assertion", () => {
  it("validates RS256 and fresh rotated keys without pinning an obsolete JWKS", async () => {
    const provider = config();
    let rotated = await generateKeyPair("RS256", { extractable: true });
    let kid = "first";
    transport.mockImplementation(async (value: string) => {
      if (value.endsWith("openid-configuration"))
        return {
          issuer: provider.issuer,
          authorization_endpoint: `${provider.issuer}/authorize`,
          token_endpoint: `${provider.issuer}/token`,
          jwks_uri: `${provider.issuer}/jwks`,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        };
      if (value.endsWith("/jwks"))
        return { keys: [{ ...(await exportJWK(rotated.publicKey)), kid, alg: "RS256" }] };
      if (value.endsWith("/token"))
        return {
          id_token: await new SignJWT({
            nonce: "nonce",
            email: "alice@example.com",
            email_verified: true,
          })
            .setProtectedHeader({ alg: "RS256", kid })
            .setIssuer(provider.issuer)
            .setAudience(provider.clientId)
            .setSubject("stable")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(rotated.privateKey),
        };
      throw new Error("unexpected endpoint");
    });
    expect(await run(provider)).toHaveProperty("subject", "stable");
    rotated = await generateKeyPair("RS256", { extractable: true });
    kid = "rotated";
    expect(await run(provider)).toHaveProperty("subject", "stable");
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/jwks"))).toHaveLength(2);
  });
  it("validates EdDSA identity tokens advertised by the provider", async () => {
    const provider = config("client_secret_basic");
    const eddsa = await generateKeyPair("EdDSA", { extractable: true });
    transport.mockImplementation(async (value: string) => {
      if (value.endsWith("openid-configuration"))
        return {
          issuer: provider.issuer,
          authorization_endpoint: `${provider.issuer}/authorize`,
          token_endpoint: `${provider.issuer}/token`,
          jwks_uri: `${provider.issuer}/jwks`,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["EdDSA"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        };
      if (value.endsWith("/jwks"))
        return { keys: [{ ...(await exportJWK(eddsa.publicKey)), kid: "eddsa", alg: "EdDSA" }] };
      if (value.endsWith("/token"))
        return {
          id_token: await new SignJWT({
            nonce: "nonce",
            email: "alice@example.com",
            email_verified: true,
          })
            .setProtectedHeader({ alg: "EdDSA", kid: "eddsa" })
            .setIssuer(provider.issuer)
            .setAudience(provider.clientId)
            .setSubject("eddsa-subject")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(eddsa.privateKey),
        };
      throw new Error("unexpected endpoint");
    });
    expect(await run(provider)).toHaveProperty("subject", "eddsa-subject");
  });
  it("bounds discovery cache size/lifetime and initializes independently in another module instance", async () => {
    const first = config();
    transport.mockImplementation(async (url: string) => {
      const issuer = url.replace(/\/\.well-known\/openid-configuration$/, "");
      return {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      };
    });
    await Promise.all([discover(first), discover(first)]);
    expect(transport).toHaveBeenCalledTimes(1);
    vi.resetModules();
    const anotherInstance = await import("../src/server/auth/oidc-runtime");
    await anotherInstance.discover(first);
    expect(transport).toHaveBeenCalledTimes(2);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
    try {
      await discover(first);
      expect(transport).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
    for (let i = 0; i < 101; i++) await discover(config());
    const before = transport.mock.calls.length;
    await discover(first);
    expect(transport.mock.calls.length).toBe(before + 1);
  });
  it.each([
    { issuer: "https://wrong.example.com" },
    { response_types_supported: ["token"] },
    { id_token_signing_alg_values_supported: ["HS256"] },
    { token_endpoint_auth_methods_supported: ["none"] },
    { code_challenge_methods_supported: ["plain"] },
    { response_types_supported: Array(51).fill("code") },
  ])("rejects unsupported or oversized discovery metadata %j", async (metadata) => {
    await expect(discover(await upstream({ metadata }))).rejects.toThrow("invalid_discovery");
  });
  it.each([
    {},
    { keys: [] },
    { keys: Array(51).fill({}) },
    { keys: [{ kty: "oct", k: "secret" }] },
  ])("rejects missing/private/oversized JWKS %j", async (jwks) => {
    const provider = await upstream();
    const original = transport.getMockImplementation()!;
    transport.mockImplementation((url: string, options: unknown) =>
      url.endsWith("/jwks") ? jwks : original(url, options),
    );
    await expect(run(provider)).rejects.toThrow("invalid_jwks");
  });
  it("rejects a missing ID token and future time claims", async () => {
    const provider = await upstream();
    const original = transport.getMockImplementation()!;
    transport.mockImplementation((url: string, options: unknown) =>
      url.endsWith("/token") ? { access_token: "not-identity" } : original(url, options),
    );
    await expect(run(provider)).rejects.toThrow("invalid_id_token");
    await expect(
      run(await upstream({ claims: { iat: Math.floor(Date.now() / 1000) + 300 } })),
    ).rejects.toThrow();
    await expect(
      run(await upstream({ claims: { nbf: Math.floor(Date.now() / 1000) + 300 } })),
    ).rejects.toThrow();
  });
  it("preserves fixed endpoint routing queries but replaces every reserved authorization value", async () => {
    const provider = await upstream({
      metadata: {
        authorization_endpoint:
          "https://routing.example.com/authorize?tenant=one&client_id=evil&client_id=evil2&RESPONSE_TYPE=token&response_type=token&scope=offline_access&state=bad&nonce=bad&redirect_uri=https://evil.example.com&code_challenge=bad&code_challenge_method=plain&response_mode=fragment",
        token_endpoint: "https://routing.example.com/token?tenant=one",
      },
    });
    provider.discoveryUrl = "https://routing.example.com/openid-configuration?tenant=one";
    const url = new URL(
      await authorizationUrl(
        provider,
        "https://weldall.example.com/callback",
        "state",
        "nonce",
        "v".repeat(43),
      ),
    );
    expect(url.searchParams.get("tenant")).toBe("one");
    for (const [name, value] of Object.entries({
      client_id: "client",
      response_type: "code",
      response_mode: "query",
      redirect_uri: "https://weldall.example.com/callback",
      scope: "openid profile email",
      state: "state",
      nonce: "nonce",
      code_challenge_method: "S256",
    }))
      expect(url.searchParams.getAll(name)).toEqual([value]);
    expect(url.searchParams.getAll("code_challenge")).toHaveLength(1);
    expect(url.searchParams.has("RESPONSE_TYPE")).toBe(false);
    await expect(run(provider)).resolves.toHaveProperty("email");
    expect(transport.mock.calls.some(([value]) => value === provider.discoveryUrl)).toBe(true);
    expect(
      transport.mock.calls.some(
        ([value]) => value === "https://routing.example.com/token?tenant=one",
      ),
    ).toBe(true);
  });
  it.each([
    "request=jwt",
    "request_uri=https://evil.example.com",
    "client_secret=secret",
    "claims=override",
  ])("rejects authorization protocol override %s", async (query) => {
    await expect(
      discover(
        await upstream({
          metadata: { authorization_endpoint: `https://routing.example.com/authorize?${query}` },
        }),
      ),
    ).rejects.toThrow("invalid_discovery");
  });
  it.each([
    "https://user:password@routing.example.com/token",
    "https://routing.example.com/token#fragment",
    "https://routing.example.com/token?grant_type=password",
  ])("rejects unsafe discovered token endpoint %s", async (token_endpoint) => {
    await expect(discover(await upstream({ metadata: { token_endpoint } }))).rejects.toThrow(
      "invalid_discovery",
    );
  });
  it.each(["client_secret_post", "client_secret_basic"] as const)(
    "validates real signature with %s",
    async (method) => {
      const provider = await upstream({ method });
      expect(await run(provider)).toMatchObject({ subject: "subject", email: "alice@example.com" });
      const call = transport.mock.calls.find(([url]) => url.endsWith("/token"))!;
      expect(call[1].body.get("code_verifier")).toBe("v".repeat(43));
      if (method === "client_secret_post") expect(call[1].body.get("client_secret")).toBe("secret");
      else {
        expect(call[1].authorization).toBe("Basic Y2xpZW50OnNlY3JldA==");
        expect(call[1].body.has("client_secret")).toBe(false);
      }
    },
  );
  it.each([
    { nonce: "wrong" },
    { iss: "https://wrong.example.com" },
    { aud: "wrong" },
    { aud: ["client", "other"] },
    { azp: "other" },
    { exp: 1 },
    { iat: 1 },
    { email_verified: false },
    { email_verified: "true" },
    { sub: "" },
  ])("rejects %j", async (claims) => expect(run(await upstream({ claims }))).rejects.toThrow());
  it("ignores upstream roles/groups and fails current domain restrictions", async () => {
    const provider = await upstream({
      claims: { roles: ["admin"], groups: ["weldall:administer"] },
    });
    const identity = await run(provider);
    expect(identity).not.toHaveProperty("roles");
    expect(identity).not.toHaveProperty("groups");
    expect(identity).not.toHaveProperty("scopes");
    provider.allowedEmailDomains = ["other.example.com"];
    await expect(run(provider)).rejects.toThrow("email_domain_denied");
  });
  it("uses UserInfo only to fill missing identity claims", async () => {
    const complete = await upstream();
    await expect(run(complete)).resolves.toHaveProperty("email", "alice@example.com");
    expect(transport.mock.calls.some(([url]) => url.endsWith("/userinfo"))).toBe(false);

    const fallback = await upstream({
      claims: { email: undefined, email_verified: undefined },
      userinfo: {
        sub: "subject",
        email: "fallback@example.com",
        email_verified: true,
        name: "Fallback User",
      },
    });
    await expect(run(fallback)).resolves.toMatchObject({
      subject: "subject",
      email: "fallback@example.com",
      name: "Fallback User",
    });
    expect(transport.mock.calls.some(([url]) => url.endsWith("/userinfo"))).toBe(true);
  });
  it("does not let UserInfo override present invalid claims or a mismatched subject", async () => {
    const invalid = await upstream({
      claims: { email_verified: false },
      userinfo: { sub: "subject", email: "alice@example.com", email_verified: true },
    });
    await expect(run(invalid)).rejects.toThrow("unverified_identity");
    expect(transport.mock.calls.some(([url]) => url.endsWith("/userinfo"))).toBe(false);

    const mismatch = await upstream({
      claims: { email: undefined, email_verified: undefined },
      userinfo: { sub: "different", email: "alice@example.com", email_verified: true },
    });
    await expect(run(mismatch)).rejects.toThrow("userinfo_subject_mismatch");
  });
  it("rejects unsigned tokens", async () => {
    await expect(run(await upstream({ token: "eyJhbGciOiJub25lIn0.e30." }))).rejects.toThrow();
  });
  it("evicts failed discovery and isolates another issuer", async () => {
    const failed = config();
    transport.mockRejectedValueOnce(new Error("offline"));
    await expect(discover(failed)).rejects.toThrow();
    const working = await upstream();
    await expect(run(working)).resolves.toHaveProperty("email");
    transport.mockRejectedValueOnce(new Error("retry reached transport"));
    await expect(discover(failed)).rejects.toThrow("retry reached transport");
  });
});
