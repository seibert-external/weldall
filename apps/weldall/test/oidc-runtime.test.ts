import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { calculatePKCECodeChallenge, type CustomFetchOptions } from "openid-client";
import { providerConfigSchema } from "../src/server/auth/oidc-config";
const transport = vi.hoisted(() => vi.fn());
vi.mock("../src/server/auth/oidc-transport", () => ({ oidcFetch: transport }));
import { authorizationUrl, discover, verifyCallback } from "../src/server/auth/oidc-runtime";

const keysets = new Map<string, Awaited<ReturnType<typeof generateKeyPair>>>();
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
const callback = "https://weldall.example.com/api/auth/callback/id";
const verifier = "v".repeat(43);
const run = (provider: ReturnType<typeof config>, query = "state=state&code=code") =>
  verifyCallback(provider, new URL(`${callback}?${query}`), "state", "nonce", verifier);
beforeAll(async () => {
  for (const alg of ["RS256", "ES256", "EdDSA", "PS256"])
    keysets.set(alg, await generateKeyPair(alg, { extractable: true }));
});
beforeEach(() => {
  transport.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});
async function upstream(
  input: {
    metadata?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    token?: string;
    tokens?: Record<string, unknown>;
    alg?: string;
    method?: "client_secret_post" | "client_secret_basic";
  } = {},
) {
  const provider = config(input.method);
  const fixture = {
    kid: "first",
    keys: keysets.get(input.alg ?? "ES256")!,
    alg: input.alg ?? "ES256",
  };
  transport.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (url === provider.discoveryUrl || path.endsWith("openid-configuration"))
      return Response.json({
        issuer: provider.issuer,
        authorization_endpoint: `${provider.issuer}/authorize`,
        token_endpoint: `${provider.issuer}/token`,
        jwks_uri: `${provider.issuer}/jwks`,
        userinfo_endpoint: `${provider.issuer}/userinfo`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: [fixture.alg],
        token_endpoint_auth_methods_supported: [provider.tokenEndpointAuthMethod],
        code_challenge_methods_supported: ["S256"],
        ...input.metadata,
      });
    if (path.endsWith("/jwks"))
      return Response.json({
        keys: [
          { ...(await exportJWK(fixture.keys.publicKey)), kid: fixture.kid, alg: fixture.alg },
        ],
      });
    if (path.endsWith("/token")) {
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        access_token: "upstream-access-token",
        token_type: "Bearer",
        id_token:
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
            .setProtectedHeader({ alg: fixture.alg, kid: fixture.kid })
            .sign(fixture.keys.privateKey)),
        ...input.tokens,
      });
    }
    throw new Error("unexpected endpoint");
  });
  return { provider, fixture };
}
const tokenCalls = () =>
  transport.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/token"));
const jwksCalls = () =>
  transport.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/jwks"));

describe("openid-client signed callback integration", () => {
  it.each(["RS256", "ES256", "EdDSA"])(
    "verifies %s with an effective multi-algorithm allowlist",
    async (alg) => {
      const { provider } = await upstream({
        alg,
        metadata: { id_token_signing_alg_values_supported: ["RS256", "ES256", "EdDSA", "PS256"] },
      });
      expect(await run(provider)).toEqual({
        issuer: provider.issuer,
        subject: "subject",
        email: "alice@example.com",
        name: "alice@example.com",
      });
    },
  );
  it.each(["client_secret_post", "client_secret_basic"] as const)(
    "uses %s and library form encoding",
    async (method) => {
      const { provider } = await upstream({ method });
      provider.clientId = "client :+&ü";
      provider.clientSecret = "secret :+&ü";
      await run(provider);
      const options = tokenCalls()[0]![1] as CustomFetchOptions;
      const body = new URLSearchParams(options.body as URLSearchParams);
      expect(body.get("code_verifier")).toBe(verifier);
      expect(body.get("redirect_uri")).toBe(callback);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(options.redirect).toBe("manual");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (method === "client_secret_post") {
        expect(body.get("client_id")).toBe(provider.clientId);
        expect(body.get("client_secret")).toBe(provider.clientSecret);
        expect(new Headers(options.headers).has("authorization")).toBe(false);
      } else {
        expect(new Headers(options.headers).get("authorization")).toBe(
          `Basic ${Buffer.from("client+%3A%2B%26%C3%BC:secret+%3A%2B%26%C3%BC").toString("base64")}`,
        );
        expect(body.has("client_secret")).toBe(false);
      }
    },
  );
  it.each([
    { nonce: "wrong" },
    { nonce: undefined },
    { iss: "https://wrong.example.com" },
    { aud: "wrong" },
    { aud: ["client", "other"] },
    { aud: ["client", "other"], azp: "other" },
    { azp: "other" },
    { exp: 1 },
    { exp: undefined },
    { iat: 1 },
    { iat: undefined },
    { sub: "" },
    { email_verified: false },
    { email_verified: "true" },
    { email: undefined },
    { email_verified: undefined },
  ])("rejects invalid signed claims %j without UserInfo", async (claims) => {
    await expect(run((await upstream({ claims })).provider)).rejects.toThrow();
    expect(transport.mock.calls.some(([url]) => url.endsWith("/userinfo"))).toBe(false);
  });
  it.each([-631, 31])("rejects iat offset %i", async (offset) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await expect(
      run((await upstream({ claims: { iat: Math.floor(Date.now() / 1000) + offset } })).provider),
    ).rejects.toThrow("invalid_id_token");
  });
  it.each([-630, 30])("accepts iat tolerance boundary %i", async (offset) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await expect(
      run((await upstream({ claims: { iat: Math.floor(Date.now() / 1000) + offset } })).provider),
    ).resolves.toHaveProperty("email");
  });
  it("accepts multi-audience azp and ignores upstream permissions; applies current domain policy on cache hits", async () => {
    const { provider } = await upstream({
      claims: { aud: ["client", "other"], azp: "client", roles: ["admin"], groups: ["admin"] },
    });
    expect(await run(provider)).not.toHaveProperty("roles");
    provider.allowedEmailDomains = ["other.example.com"];
    await expect(run(provider)).rejects.toThrow("email_domain_denied");
  });
  it.each([
    { id_token: undefined },
    { id_token: "eyJhbGciOiJub25lIn0.e30." },
    { id_token: "malformed" },
    { access_token: undefined },
    { token_type: undefined },
  ])("rejects incomplete/invalid token responses %j", async (tokens) => {
    await expect(run((await upstream({ tokens })).provider)).rejects.toThrow("invalid_id_token");
  });
  it("rejects valid signatures using an unapproved or unadvertised algorithm", async () => {
    for (const input of [
      { alg: "PS256", metadata: { id_token_signing_alg_values_supported: ["PS256", "ES256"] } },
      { alg: "ES256", metadata: { id_token_signing_alg_values_supported: ["RS256"] } },
    ])
      await expect(run((await upstream(input)).provider)).rejects.toThrow("invalid_id_token");
  });
  it("rejects a tampered signature with matching kid/algorithm", async () => {
    const { provider } = await upstream();
    const otherKeys = await generateKeyPair("ES256", { extractable: true });
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, options) =>
      url.endsWith("/jwks")
        ? Response.json({
            keys: [{ ...(await exportJWK(otherKeys.publicKey)), kid: "first", alg: "ES256" }],
          })
        : original(url, options),
    );
    await expect(run(provider)).rejects.toThrow("invalid_id_token");
  });
  it("rejects invalid signatures and malformed JWKS using library verification", async () => {
    for (const jwks of [
      { keys: [] },
      { keys: [{ kty: "oct", k: "secret" }] },
      {},
      { keys: [{ ...(await exportJWK(keysets.get("RS256")!.publicKey)), kid: "first" }] },
    ]) {
      const { provider } = await upstream();
      const original = transport.getMockImplementation()!;
      transport.mockImplementation((url, options) =>
        url.endsWith("/jwks") ? Response.json(jwks) : original(url, options),
      );
      await expect(run(provider)).rejects.toThrow("invalid_id_token");
    }
  });
  it.each([
    "state=wrong&code=code",
    "code=code",
    "state=state",
    "state=state&code=code&code=other",
    "state=state&state=state&code=code",
    "state=state&code=code&iss=https://wrong.example.com",
    "state=state&code=code&iss=x&iss=x",
    "state=state&error=access_denied&error=other",
  ])("library rejects callback %s before token exchange", async (query) => {
    await expect(run((await upstream()).provider, query)).rejects.toThrow("invalid_id_token");
    expect(tokenCalls()).toHaveLength(0);
  });
  it("preserves advertised response issuer requirements on both discovery paths", async () => {
    for (const custom of [false, true]) {
      const { provider } = await upstream({
        metadata: { authorization_response_iss_parameter_supported: true },
      });
      if (custom) provider.discoveryUrl = "https://routing.example.com/metadata?tenant=one";
      await expect(run(provider)).rejects.toThrow("invalid_id_token");
      expect(tokenCalls()).toHaveLength(0);
      await expect(
        run(provider, `state=state&code=code&iss=${encodeURIComponent(provider.issuer)}`),
      ).resolves.toHaveProperty("email");
      transport.mockClear();
    }
  });
  it("maps cancellation and token endpoint errors without leaking causes or retrying", async () => {
    const { provider } = await upstream();
    await expect(
      run(provider, "state=state&error=access_denied&error_description=secret"),
    ).rejects.toThrow("authorization_cancelled");
    const original = transport.getMockImplementation()!;
    transport.mockImplementation((url, options) =>
      url.endsWith("/token")
        ? Response.json({ error: "invalid_grant", error_description: "secret" }, { status: 400 })
        : original(url, options),
    );
    await expect(run(provider)).rejects.toThrow("invalid_id_token");
    expect(tokenCalls()).toHaveLength(1);
  });
  it("reuses JWKS and permits unknown-key refetch after one minute, then refreshes at five minutes", async () => {
    const { provider, fixture } = await upstream({ alg: "RS256" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await run(provider);
    await run(provider);
    expect(jwksCalls()).toHaveLength(1);
    fixture.kid = "rotated";
    fixture.keys = await generateKeyPair("RS256", { extractable: true });
    await expect(run(provider)).rejects.toThrow("invalid_id_token");
    expect(jwksCalls()).toHaveLength(1);
    clock.mockReturnValue(now + 61000);
    await run(provider);
    expect(jwksCalls()).toHaveLength(2);
    clock.mockReturnValue(now + 301000);
    await run(provider);
    expect(jwksCalls()).toHaveLength(3);
  });
});

describe("lazy policy-constrained configurations", () => {
  it.each([
    { issuer: "https://wrong.example.com" },
    { response_types_supported: ["token"] },
    { id_token_signing_alg_values_supported: ["HS256"] },
    { token_endpoint_auth_methods_supported: ["none"] },
    { code_challenge_methods_supported: ["plain"] },
    { authorization_endpoint: undefined },
    { token_endpoint: undefined },
    { jwks_uri: undefined },
  ])("rejects unsuitable metadata %j", async (metadata) => {
    await expect(discover((await upstream({ metadata })).provider)).rejects.toThrow(
      "invalid_discovery",
    );
  });
  it("rejects malformed protocol JSON and non-object discovery on both construction paths", async () => {
    for (const custom of [false, true]) {
      for (const body of ["not-json", "[]", "null"]) {
        const { provider } = await upstream();
        if (custom) provider.discoveryUrl = "https://routing.example.com/metadata";
        transport.mockResolvedValueOnce(
          new Response(body, { headers: { "content-type": "application/json" } }),
        );
        await expect(discover(provider)).rejects.toThrow("invalid_discovery");
      }
    }
    for (const endpoint of ["/token", "/jwks"]) {
      const { provider } = await upstream();
      const original = transport.getMockImplementation()!;
      transport.mockImplementation((url, options) =>
        url.endsWith(endpoint)
          ? new Response("not-json", { headers: { "content-type": "application/json" } })
          : original(url, options),
      );
      await expect(run(provider)).rejects.toThrow("invalid_id_token");
    }
  });
  it("requires exact issuer spelling even when URL normalization would match", async () => {
    for (const custom of [false, true]) {
      const { provider } = await upstream();
      provider.issuer = "https://ID.example.com:443/tenant";
      if (custom) provider.discoveryUrl = "https://routing.example.com/metadata?tenant=one";
      const original = transport.getMockImplementation()!;
      transport.mockImplementation(async (url, options) => {
        const response = await original(url, options);
        const data = await response.json();
        return Response.json({ ...data, issuer: "https://id.example.com/tenant" });
      });
      await expect(discover(provider)).rejects.toThrow("invalid_discovery");
    }
  });
  it("uses issuer paths and arbitrary discovery URLs/queries, preserves routing, defaults Basic and always sends S256", async () => {
    const { provider } = await upstream({
      method: "client_secret_basic",
      metadata: {
        token_endpoint_auth_methods_supported: undefined,
        code_challenge_methods_supported: undefined,
        authorization_endpoint: "https://routing.example.com/authorize?tenant=one",
        token_endpoint: "https://routing.example.com/token?tenant=one",
      },
    });
    for (const custom of [false, true]) {
      if (custom)
        provider.discoveryUrl = "https://routing.example.com/arbitrary/metadata?tenant=one";
      const url = new URL(await authorizationUrl(provider, callback, "state", "nonce", verifier));
      expect(Object.fromEntries(url.searchParams)).toEqual({
        tenant: "one",
        client_id: provider.clientId,
        redirect_uri: callback,
        scope: "openid profile email",
        state: "state",
        nonce: "nonce",
        response_type: "code",
        response_mode: "query",
        code_challenge_method: "S256",
        code_challenge: await calculatePKCECodeChallenge(verifier),
      });
      await run(provider);
    }
    expect(
      transport.mock.calls.some(
        ([url]) => url === `${provider.issuer}/.well-known/openid-configuration`,
      ),
    ).toBe(true);
    expect(transport.mock.calls.some(([url]) => url === provider.discoveryUrl)).toBe(true);
    expect(
      tokenCalls().every(([url]) => url === "https://routing.example.com/token?tenant=one"),
    ).toBe(true);
  });
  it.each([
    "client_id=evil",
    "RESPONSE_TYPE=token",
    "scope=offline_access",
    "request=jwt",
    "request_uri=https://evil.example.com",
    "client_secret=secret",
    "claims=override",
    "code=bad",
  ])("rejects reserved endpoint query %s rather than repairing metadata", async (query) => {
    for (const endpoint of ["authorization_endpoint", "token_endpoint", "jwks_uri"])
      await expect(
        discover(
          (
            await upstream({
              metadata: { [endpoint]: `https://routing.example.com/endpoint?${query}` },
            })
          ).provider,
        ),
      ).rejects.toThrow("invalid_discovery");
  });
  it.each([
    "http://routing.example.com/token",
    "https://user:password@routing.example.com/token",
    "https://routing.example.com/token#fragment",
  ])("rejects unsafe endpoints %s", async (token_endpoint) => {
    await expect(
      discover((await upstream({ metadata: { token_endpoint } })).provider),
    ).rejects.toThrow("invalid_discovery");
  });
  it("bounds cache size/lifetime and isolates module instances and failed providers", async () => {
    const first = config();
    transport.mockImplementation(async (url: string) => {
      const issuer = url.replace(/\/\.well-known\/openid-configuration$/, "");
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    });
    await Promise.all([discover(first), discover(first)]);
    expect(transport).toHaveBeenCalledTimes(1);
    vi.resetModules();
    await (await import("../src/server/auth/oidc-runtime")).discover(first);
    expect(transport).toHaveBeenCalledTimes(2);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
    await discover(first);
    expect(transport).toHaveBeenCalledTimes(3);
    clock.mockRestore();
    for (let i = 0; i < 101; i++) await discover(config());
    const before = transport.mock.calls.length;
    await discover(first);
    expect(transport.mock.calls.length).toBe(before + 1);
    const failed = config();
    transport.mockRejectedValueOnce(new Error("sensitive upstream failure"));
    await expect(discover(failed)).rejects.toThrow("invalid_discovery");
    await discover(config());
    await discover(failed);
  });
  it("keys clients by credentials, client ID, discovery and authentication method, not draft identity", async () => {
    const { provider } = await upstream({
      metadata: {
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      },
    });
    for (const change of [
      {},
      { clientSecret: "replacement" },
      { clientId: "other" },
      { tokenEndpointAuthMethod: "client_secret_basic" as const },
      { discoveryUrl: "https://routing.example.com/metadata" },
    ]) {
      Object.assign(provider, change);
      await discover(provider);
    }
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it("sets eight-second timeouts for both discovery paths, token and JWKS", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    for (const custom of [false, true]) {
      const { provider } = await upstream();
      if (custom) provider.discoveryUrl = "https://routing.example.com/metadata";
      await run(provider);
    }
    expect(timeout).toHaveBeenCalledTimes(6);
    expect(timeout.mock.calls.every(([milliseconds]) => milliseconds === 8000)).toBe(true);
  });
});
