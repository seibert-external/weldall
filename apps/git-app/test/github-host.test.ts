import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { deriveWebBaseUrl, parseGitHubAppConfiguration } from "../src/hosts/github/config.js";
import { parseGitHubAppPrivateKey } from "../src/hosts/github/private-key.js";
import { createAppJwt } from "../src/hosts/github/jwt.js";
import {
  createInstallationTokenCache,
  TOKEN_REFUSAL_TTL_MS,
  TOKEN_RENEWAL_MARGIN_MS,
} from "../src/hosts/github/tokens.js";
import { createGitHubAppHost } from "../src/hosts/github/host.js";
import { GitAppError } from "../src/errors.js";

// Test keys are generated per run; no key material is committed.
const rsa = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const pkcs8 = parseGitHubAppPrivateKey(rsa.privateKey);
const config = {
  appId: "123456",
  organization: "acme-apps",
  installationId: "987654",
  templates: [{ name: "react", repository: "acme-templates/react-app" }],
  repositoryNamePrefix: "app-",
  reviewerTeam: "app-reviewers",
  setupMode: "customer-managed",
};
const parsedConfig = parseGitHubAppConfiguration(config);
const app = {
  apiBaseUrl: parsedConfig.apiBaseUrl,
  appId: parsedConfig.appId,
  organization: parsedConfig.organization,
  installationId: parsedConfig.installationId,
};
const signal = () => AbortSignal.timeout(5_000);
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

function verifyJwt(jwt: string) {
  const [header, payload, signature] = jwt.split(".");
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(rsa.publicKey),
      Buffer.from(signature!, "base64url"),
    ),
  ).toBe(true);
  return { header: decode(header!), payload: decode(payload!) };
}

/** Mocked GitHub: records requests and issues one token per call. */
function mockGitHub(options: { status?: number; extra?: object; now?: () => number } = {}) {
  let issued = 0;
  const calls: { url: string; method: string; headers: Headers; body: any }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/orgs/acme-apps/installation")) return Response.json({ id: 555 });
    if (options.status) return Response.json({ message: "secret-ish upstream detail" }, options);
    issued += 1;
    return Response.json(
      {
        token: `ghs_test_token_${issued}`,
        expires_at: new Date((options.now ?? Date.now)() + 60 * 60_000).toISOString(),
        permissions: { ...JSON.parse(String(init?.body)).permissions, metadata: "read" },
        repository_selection: "selected",
        ...(JSON.parse(String(init?.body)).repositories
          ? {
              repositories: JSON.parse(String(init?.body)).repositories.map((name: string) => ({
                name,
              })),
            }
          : {}),
        ...options.extra,
      },
      { status: 201 },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GitHub App private key validation", () => {
  it("accepts unencrypted RSA keys as GitHub issues them and stores canonical PKCS#8", () => {
    expect(pkcs8.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(parseGitHubAppPrivateKey(`\r\n${rsa.privateKey.replace(/\n/g, "\r\n")}`)).toBe(pkcs8);
    expect(parseGitHubAppPrivateKey(pkcs8)).toBe(pkcs8);
  });

  const ec = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const small = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const encrypted = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-passphrase",
    },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const encryptedPkcs1 = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-passphrase",
    },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  it.each([
    ["empty", "", "empty"],
    ["not a string", 42, "empty"],
    ["oversized", "A".repeat(16 * 1024 + 1), "too large"],
    ["garbage", "not a key", "single PEM block"],
    ["two blocks", `${rsa.privateKey}\n${rsa.privateKey}`, "single PEM block"],
    ["public key", rsa.publicKey, "PUBLIC KEY instead of a private key"],
    ["EC key", ec.privateKey, "RSA keys"],
    ["1024-bit RSA", small.privateKey, "at least 2048 bits"],
    ["encrypted PKCS#8", encrypted.privateKey, "Encrypted keys"],
    ["encrypted PKCS#1", encryptedPkcs1.privateKey, "Encrypted keys"],
    ["corrupted body", rsa.privateKey.replace(/\n[A-Za-z0-9+/]{10}/, "\nAAAAAAAAAA"), "could not"],
  ])("rejects %s with a clear message and no key material", (_name, value, message) => {
    let caught: unknown;
    try {
      parseGitHubAppPrivateKey(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitAppError);
    expect(caught).toMatchObject({ code: "invalid_private_key" });
    expect((caught as Error).message).toContain(message);
    expect((caught as Error).message).toContain("PEM file GitHub generated");
    const body = typeof value === "string" ? value.split("\n")[1] : undefined;
    if (body) expect((caught as Error).message).not.toContain(body.slice(0, 20));
  });
});

describe("GitHub App JWT", () => {
  it("signs RS256 with a backdated iat, a nine-minute exp and the App ID as issuer", () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0);
    const jwt = createAppJwt({ appId: "123456", privateKey: pkcs8, now });
    const { header, payload } = verifyJwt(jwt);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "123456" });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });
});

describe("GitHub App configuration", () => {
  it("defaults to github.com and normalises numeric IDs", () => {
    expect(parsedConfig.apiBaseUrl).toBe("https://api.github.com");
    expect(parseGitHubAppConfiguration({ ...config, appId: 123456 }).appId).toBe("123456");
    expect(deriveWebBaseUrl("https://api.github.com")).toBe("https://github.com");
    expect(deriveWebBaseUrl("https://api.acme.ghe.com")).toBe("https://acme.ghe.com");
    expect(deriveWebBaseUrl("https://git.example.com/api/v3")).toBeNull();
    const { installationId: _omitted, ...byOrganisation } = config;
    expect(parseGitHubAppConfiguration(byOrganisation)).not.toHaveProperty("installationId");
  });

  it("rejects the unbuilt setup mode with an explanation instead of treating it like the other", () => {
    expect(() => parseGitHubAppConfiguration({ ...config, setupMode: "weldall-managed" })).toThrow(
      expect.objectContaining({
        code: "unsupported_setup_mode",
        message: expect.stringContaining('"weldall-managed" is not available yet'),
      }),
    );
    expect(() => parseGitHubAppConfiguration({ ...config, setupMode: "other" })).toThrow(ZodError);
  });

  it.each([
    { apiBaseUrl: "http://api.github.com" },
    { apiBaseUrl: "https://api.github.com/" },
    { apiBaseUrl: "https://example.com" },
    { apiBaseUrl: "https://git.example.com/api/v3" },
    { apiBaseUrl: "https://10.0.0.5/api/v3" },
    { apiBaseUrl: "https://api.github.com/api/v3" },
    { apiBaseUrl: "https://user:pass@api.acme.ghe.com" },
    { apiBaseUrl: "https://api.acme.ghe.com:8443" },
    { apiBaseUrl: "https://api.ghe.com" },
    { appId: "0123" },
    { organization: "-acme" },
    { installationId: "abc" },
    { templates: [] },
    { templates: [config.templates[0], config.templates[0]] },
    { templates: [{ name: "react", repository: "acme/a/b" }] },
    { repositoryNamePrefix: "app/" },
    { reviewerTeam: "Reviewers" },
    { setupMode: undefined },
    { privateKey: "never in public configuration" },
  ])("rejects invalid public configuration %j", (patch) => {
    expect(() => parseGitHubAppConfiguration({ ...config, ...patch })).toThrow();
  });
});

describe("installation tokens", () => {
  const loadPrivateKey = vi.fn(async () => pkcs8);
  const mint = (
    cache: ReturnType<typeof createInstallationTokenCache>,
    permissions: Record<string, "read" | "write">,
    repository = "app-one",
  ) => cache.mint({ app, loadPrivateKey, repository, permissions, signal: signal() });

  it("requests a token restricted to one repository and the given permissions", async () => {
    const { calls } = mockGitHub();
    const token = await mint(createInstallationTokenCache(), { contents: "write" });
    expect(token.token).toBe("ghs_test_token_1");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://api.github.com/app/installations/987654/access_tokens");
    expect(call!.method).toBe("POST");
    expect(call!.body).toEqual({ repositories: ["app-one"], permissions: { contents: "write" } });
    expect(call!.headers.get("accept")).toBe("application/vnd.github+json");
    expect(call!.headers.get("x-github-api-version")).toBe("2022-11-28");
    const authorization = call!.headers.get("authorization")!;
    expect(authorization.startsWith("Bearer ")).toBe(true);
    expect(verifyJwt(authorization.slice(7)).payload.iss).toBe("123456");
  });

  it("mints the installation-wide creation token with an empty body and never caches it", async () => {
    const wide = {
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      repository_creation: "write",
    };
    const { calls } = mockGitHub({ extra: { permissions: wide } });
    const cache = createInstallationTokenCache();
    const first = await cache.mintRepositoryCreationToken({
      app,
      loadPrivateKey,
      signal: signal(),
    });
    const second = await cache.mintRepositoryCreationToken({
      app,
      loadPrivateKey,
      signal: signal(),
    });
    expect([first.token, second.token]).toEqual(["ghs_test_token_1", "ghs_test_token_2"]);
    // GitHub refused `generate` with every narrower token (measured 17.11.2026).
    expect(calls.map(({ body }) => body)).toEqual([{}, {}]);
    // Repository-bound tokens never reuse it.
    const bound = mockGitHub();
    await mint(cache, { contents: "write" });
    expect(bound.calls.map(({ body }) => body)).toEqual([
      { repositories: ["app-one"], permissions: { contents: "write" } },
    ]);
  });

  it("refuses the creation token unless the installation grants creation and contents", async () => {
    for (const [permissions, missing] of [
      [{ contents: "write", metadata: "read" }, "repository_creation: write"],
      [{ repository_creation: "write", metadata: "read" }, "contents: read"],
    ] as const) {
      mockGitHub({ extra: { permissions } });
      await expect(
        createInstallationTokenCache().mintRepositoryCreationToken({
          app,
          loadPrivateKey,
          signal: signal(),
        }),
      ).rejects.toMatchObject({
        code: "repository_creation_not_permitted",
        message: expect.stringContaining(missing),
      });
    }
  });

  it("still requires repositories in the response of a repository-bound request", async () => {
    mockGitHub({ extra: { repositories: undefined } });
    await expect(mint(createInstallationTokenCache(), { contents: "read" })).rejects.toMatchObject({
      code: "grant_mismatch",
    });
  });

  it("caches per installation, repository and permission set and loads the key only on a miss", async () => {
    const { calls } = mockGitHub();
    loadPrivateKey.mockClear();
    const cache = createInstallationTokenCache();
    const first = await mint(cache, { contents: "write" });
    expect(await mint(cache, { contents: "write" })).toEqual(first);
    expect(loadPrivateKey).toHaveBeenCalledOnce();
    expect((await mint(cache, { contents: "read" })).token).not.toBe(first.token);
    expect((await mint(cache, { contents: "write" }, "app-two")).token).not.toBe(first.token);
    expect((await mint(cache, { pull_requests: "read", checks: "read" })).token).not.toBe(
      first.token,
    );
    // Same set in another order shares the entry.
    expect(await mint(cache, { checks: "read", pull_requests: "read" })).toMatchObject({
      token: "ghs_test_token_4",
    });
    expect(calls).toHaveLength(4);
    expect(calls.map(({ body }) => body.permissions)).toEqual([
      { contents: "write" },
      { contents: "read" },
      { contents: "write" },
      { checks: "read", pull_requests: "read" },
    ]);
  });

  it("renews a token shortly before it expires", async () => {
    let now = Date.now();
    const { calls } = mockGitHub({ now: () => now });
    const cache = createInstallationTokenCache({ now: () => now });
    const first = await mint(cache, { contents: "write" });
    now = first.expiresAt.getTime() - TOKEN_RENEWAL_MARGIN_MS - 1_000;
    expect(await mint(cache, { contents: "write" })).toEqual(first);
    now = first.expiresAt.getTime() - TOKEN_RENEWAL_MARGIN_MS + 1_000;
    expect((await mint(cache, { contents: "write" })).token).toBe("ghs_test_token_2");
    expect(calls).toHaveLength(2);
  });

  it("shares one upstream call between concurrent callers", async () => {
    const { calls } = mockGitHub();
    const cache = createInstallationTokenCache();
    const tokens = await Promise.all([
      mint(cache, { contents: "write" }),
      mint(cache, { contents: "write" }),
    ]);
    expect(tokens[0]).toEqual(tokens[1]);
    expect(calls).toHaveLength(1);
  });

  it("resolves and caches the installation from the organisation when no ID is configured", async () => {
    const { calls } = mockGitHub();
    const cache = createInstallationTokenCache();
    const byOrganisation = { ...app, installationId: undefined };
    for (const repository of ["app-one", "app-two"])
      await cache.mint({
        app: byOrganisation,
        loadPrivateKey,
        repository,
        permissions: { contents: "read" },
        signal: signal(),
      });
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://api.github.com/orgs/acme-apps/installation",
      "POST https://api.github.com/app/installations/555/access_tokens",
      "POST https://api.github.com/app/installations/555/access_tokens",
    ]);
  });

  it.each([
    [401, "credential_rejected"],
    [404, "installation_not_found"],
    [422, "token_refused"],
    [429, "upstream_rate_limited"],
    [500, "upstream_unavailable"],
  ])("maps HTTP %i to %s without upstream details", async (status, code) => {
    mockGitHub({ status });
    const error = await mint(createInstallationTokenCache(), { contents: "write" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain("secret-ish");
  });

  it.each([
    { permissions: { contents: "write", administration: "write" } },
    { repositories: [{ name: "app-one" }, { name: "other" }] },
    { repositories: [{ name: "other" }] },
    { repositories: undefined },
    { permissions: undefined },
  ])("fails closed when GitHub issues a broader token: %j", async (extra) => {
    mockGitHub({ extra });
    await expect(mint(createInstallationTokenCache(), { contents: "write" })).rejects.toMatchObject(
      { code: "grant_mismatch" },
    );
  });

  it("remembers a refused token request for opted-in callers, per repository and permission set", async () => {
    let now = Date.now();
    const cache = createInstallationTokenCache({ now: () => now });
    const reusing = (permissions: Record<string, "read" | "write">, repository = "app-one") =>
      cache.mint({
        app,
        loadPrivateKey,
        repository,
        permissions,
        signal: signal(),
        reuseRefusal: true,
      });
    const refused = mockGitHub({ status: 422 });
    await expect(reusing({ checks: "read" })).rejects.toMatchObject({ code: "token_refused" });
    // The same refusal again, from memory.
    await expect(reusing({ checks: "read" })).rejects.toMatchObject({ code: "token_refused" });
    expect(refused.calls).toHaveLength(1);
    // Another repository, another permission set and a caller without the option still ask GitHub.
    await expect(reusing({ checks: "read" }, "app-two")).rejects.toMatchObject({
      code: "token_refused",
    });
    await expect(reusing({ statuses: "read" })).rejects.toMatchObject({ code: "token_refused" });
    await expect(mint(cache, { checks: "read" })).rejects.toMatchObject({
      code: "token_refused",
    });
    expect(refused.calls.map(({ body }) => [body.repositories, body.permissions])).toEqual([
      [["app-one"], { checks: "read" }],
      [["app-two"], { checks: "read" }],
      [["app-one"], { statuses: "read" }],
      [["app-one"], { checks: "read" }],
    ]);

    // After the expiry a permission granted meanwhile is picked up, still restricted to the one
    // repository and permission set.
    now += TOKEN_REFUSAL_TTL_MS + 1;
    const granted = mockGitHub({ now: () => now });
    expect((await reusing({ checks: "read" })).token).toBe("ghs_test_token_1");
    expect(granted.calls.map(({ body }) => body)).toEqual([
      { repositories: ["app-one"], permissions: { checks: "read" } },
    ]);
  });

  it("forgets a refusal as soon as a token for the same key is issued", async () => {
    const cache = createInstallationTokenCache();
    const reusing = () =>
      cache.mint({
        app,
        loadPrivateKey,
        repository: "app-one",
        permissions: { checks: "read" },
        signal: signal(),
        reuseRefusal: true,
      });
    mockGitHub({ status: 422 });
    await expect(reusing()).rejects.toMatchObject({ code: "token_refused" });
    // A caller that always asks (e.g. after the grant) gets the token; it replaces the refusal.
    const granted = mockGitHub();
    const token = await mint(cache, { checks: "read" });
    expect(await reusing()).toEqual(token);
    expect(granted.calls).toHaveLength(1);
  });

  it.each([
    [404, "installation_not_found"],
    [429, "upstream_rate_limited"],
    [500, "upstream_unavailable"],
  ])("does not remember HTTP %i, only a refused permission", async (status) => {
    const cache = createInstallationTokenCache();
    const { calls } = mockGitHub({ status });
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        cache.mint({
          app,
          loadPrivateKey,
          repository: "app-one",
          permissions: { checks: "read" },
          signal: signal(),
          reuseRefusal: true,
        }),
      ).rejects.toBeInstanceOf(GitAppError);
    expect(calls).toHaveLength(2);
  });

  it("rejects invalid permission sets before contacting GitHub", async () => {
    const { fetcher } = mockGitHub();
    const cache = createInstallationTokenCache();
    await expect(mint(cache, {})).rejects.toMatchObject({ code: "invalid_permissions" });
    await expect(mint(cache, { contents: "admin" as "write" })).rejects.toMatchObject({
      code: "invalid_permissions",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("GitHub App Git host", () => {
  it("forwards to the organisation's repository with a repository-bound token", async () => {
    const { calls } = mockGitHub();
    const host = createGitHubAppHost({
      config: parsedConfig,
      loadPrivateKey: async () => pkcs8,
      tokens: createInstallationTokenCache(),
    });
    expect(host.setupMode).toBe("customer-managed");
    const target = await host.getForwardingTarget(
      { repository: { owner: "ACME-apps", name: "app-one" }, access: "write" },
      signal(),
    );
    expect(target.url.href).toBe("https://github.com/acme-apps/app-one.git");
    expect(
      Buffer.from(target.authorization.replace(/^Basic /, ""), "base64").toString("utf8"),
    ).toBe("x-access-token:ghs_test_token_1");
    expect(target.expiresAt).toBeInstanceOf(Date);
    expect(calls[0]!.body.permissions).toEqual({ contents: "write" });
    await host.getForwardingTarget(
      { repository: { owner: "acme-apps", name: "app-one" }, access: "read" },
      signal(),
    );
    expect(calls[1]!.body.permissions).toEqual({ contents: "read" });
    await expect(
      host.getForwardingTarget(
        { repository: { owner: "someone-else", name: "app-one" }, access: "read" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });
    await expect(
      host.getForwardingTarget(
        { repository: { owner: "acme-apps", name: "../app" }, access: "read" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [[], null],
    [[{ state: "closed", merged_at: null }], "closed"],
    [
      [
        { state: "closed", merged_at: null },
        { state: "closed", merged_at: "2026-11-17T10:00:00Z" },
      ],
      "merged",
    ],
    [
      [
        { state: "closed", merged_at: "2026-11-17T10:00:00Z" },
        { state: "open", merged_at: null },
      ],
      "open",
    ],
  ])("reads the pull request state of a branch: %j", async (pulls, expected) => {
    const calls: { url: string; authorization: string | null }[] = [];
    let tokenBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/access_tokens")) {
          tokenBody = JSON.parse(String(init?.body));
          return Response.json(
            {
              token: "ghs_pull_token",
              expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
              permissions: { ...tokenBody.permissions, metadata: "read" },
              repositories: [{ name: "app-one" }],
            },
            { status: 201 },
          );
        }
        return Response.json(pulls);
      }),
    );
    const host = createGitHubAppHost({
      config: parsedConfig,
      loadPrivateKey: async () => pkcs8,
      tokens: createInstallationTokenCache(),
    });
    await expect(
      host.readBranchPullRequestState(
        { repository: { owner: "acme-apps", name: "app-one" }, branch: "weldall/publish-1" },
        signal(),
      ),
    ).resolves.toBe(expected);
    expect(tokenBody).toEqual({
      repositories: ["app-one"],
      permissions: { pull_requests: "read" },
    });
    const lookup = new URL(calls.at(-1)!.url);
    expect(lookup.pathname).toBe("/repos/acme-apps/app-one/pulls");
    expect(Object.fromEntries(lookup.searchParams)).toEqual({
      state: "all",
      head: "acme-apps:weldall/publish-1",
      per_page: "100",
    });
    expect(calls.at(-1)!.authorization).toBe("Bearer ghs_pull_token");
  });

  it("fails the pull request lookup closed on an unexpected GitHub answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/access_tokens")
          ? Response.json(
              {
                token: "ghs_pull_token",
                expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
                permissions: { pull_requests: "read" },
                repositories: [{ name: "app-one" }],
              },
              { status: 201 },
            )
          : Response.json({ message: "Server Error" }, { status: 500 }),
      ),
    );
    const host = createGitHubAppHost({
      config: parsedConfig,
      loadPrivateKey: async () => pkcs8,
      tokens: createInstallationTokenCache(),
    });
    await expect(
      host.readBranchPullRequestState(
        { repository: { owner: "acme-apps", name: "app-one" }, branch: "weldall/publish-1" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});
