import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair, type ResourceRegistryEntry } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { CliError, ConfigurationError } from "../src/errors.js";
import type { AccessSession } from "../src/services/session-manager.js";

/**
 * How the CLI finds and trusts a registry (`git/registries.ts`), and the direct access of the git
 * credential helper and of the app commands: the real downstream flow (Weldall's registry list
 * `GET /api/me/apps` and resource registry, token exchange at Weldall, downstream token at the
 * registry, DPoP request) against a stubbed `fetch`. Only the ID-JAG signature check is replaced.
 *
 * The trust decision these tests state: only Weldall's `registries` make a resource a registry. A
 * resource's own protected resource metadata is never read, so a registered resource that
 * announces an apps API there gets nothing.
 */
vi.mock("../src/oauth/session.js", async (original) => ({
  ...(await original<typeof import("../src/oauth/session.js")>()),
  validateIdJagResponse: async () => "downstream-assertion",
}));
import {
  httpsOrigin,
  registryFromListing,
  selectRegistry,
  trustedRegistries,
  type FoundRegistries,
} from "../src/git/registries.js";
import {
  directOpenRegistry,
  directWeldallAccess,
  retryAfterSeconds,
} from "../src/git/weldall-access.js";
import { createRegistryApi } from "../src/publish/registry-api.js";
import { parseAppRegistries, type AppRegistryListing } from "../src/services/apps.js";

const ISSUER = "https://weldall.example.com";
const ORIGIN = "https://registry.example.com";
const APPS = `${ISSUER}/api/me/apps`;
const config: WeldallConfig = {
  issuer: ISSUER,
  resource: `${ISSUER}/api`,
  authorize: `${ISSUER}/api/auth/oauth2/authorize`,
  token: `${ISSUER}/api/auth/oauth2/token`,
  revoke: `${ISSUER}/api/auth/oauth2/revoke`,
  jwks: `${ISSUER}/api/oauth/jwks`,
  cli: `${ISSUER}/api/me/cli`,
  grants: `${ISSUER}/api/me/grants`,
  scopes: `${ISSUER}/api/me/scopes`,
  skills: `${ISSUER}/api/me/skills`,
  userInfo: `${ISSUER}/api/auth/oauth2/userinfo`,
};
const registryResource = (
  key = "registry",
  origin = ORIGIN,
  grantedScopes = ["registry:publish"],
  supportedScopes = ["registry:admin", "registry:agents", "registry:publish"],
): ResourceRegistryEntry => ({
  key,
  name: `Registry ${key}`,
  resourceIdentifier: `${origin}/api`,
  authorizationServer: origin,
  downstreamClientId: "weldall-cli-at-registry",
  requestPrefixes: [`${origin}/api`],
  supportedScopes,
  grantedScopes,
});
/** One registry as Weldall lists it in `GET /api/me/apps`. */
const listingOf = (
  key = "registry",
  origin = ORIGIN,
  patch: Partial<AppRegistryListing> = {},
): AppRegistryListing => ({
  key,
  name: `Registry ${key}`,
  resource: `${origin}/api`,
  endpoint: `${origin}/api/apps`,
  scope: "registry:publish",
  allowed: true,
  adminScope: "registry:admin",
  adminAllowed: false,
  git: `${origin}/git/`,
  gitCredentials: `${origin}/api/git-credentials`,
  ...patch,
});
/** What a registry serves as its own metadata: the CLI must never read it. */
const announcingMetadata = (origin: string) => ({
  resource: `${origin}/api`,
  authorization_servers: [origin],
  weldall_apps_api: {
    endpoint: `${origin}/api/apps`,
    scope: "expenses:read",
    git: `${origin}/git/`,
    gitCredentials: `${origin}/api/git-credentials`,
  },
});
const EXPENSES = "https://expenses.example.com";
const expenses: ResourceRegistryEntry = {
  key: "expenses",
  name: "Expenses",
  resourceIdentifier: `${EXPENSES}/api`,
  authorizationServer: EXPENSES,
  downstreamClientId: "weldall-cli-at-expenses",
  requestPrefixes: [`${EXPENSES}/api`],
  supportedScopes: ["expenses:read"],
  grantedScopes: ["expenses:read"],
};
const credential = {
  username: "weldall",
  password: `wgc_${"a".repeat(8)}.${"b".repeat(40)}.${"c".repeat(43)}`,
  expiresAt: "2026-11-19T12:05:00.000Z",
};

let session: AccessSession;
let registry: ResourceRegistryEntry[];
/** Weldall's `GET /api/me/apps` answer; null answers 404 (a server without the route). */
let appsAnswer: Record<string, unknown> | null;
let calls: Array<{ url: string; init: RequestInit | undefined }>;
/** Statuses the registry answers its next API requests with, before the usual answer. */
let registryStatuses: number[];
const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  if (url === config.scopes) return Response.json(registry);
  if (url === APPS)
    return appsAnswer === null
      ? new Response("<html>Not Found</html>", { status: 404 })
      : Response.json(appsAnswer);
  if (url === config.token) return Response.json({ access_token: "id-jag" });
  if (url.endsWith("/.well-known/oauth-protected-resource"))
    return Response.json(announcingMetadata(new URL(url).origin));
  if (url.endsWith("/oauth/token"))
    return Response.json({
      token_type: "DPoP",
      access_token: `registry-token-${calls.filter((call) => call.url.endsWith("/oauth/token")).length}`,
      expires_in: 300,
    });
  const status = url.startsWith(`${ORIGIN}/api/`) ? registryStatuses.shift() : undefined;
  if (status !== undefined)
    return Response.json({ error: "invalid_token", error_description: "Expired." }, { status });
  if (url === `${ORIGIN}/api/git-credentials` || url === `${EXPENSES}/api/git-credentials`)
    return Response.json(credential);
  if (url === `${ORIGIN}/api/apps/app1/status`)
    return Response.json({ error: "not_found", error_description: "No app." }, { status: 404 });
  if (url === `${ORIGIN}/api/apps`)
    return Response.json(
      { error: "rate_limit", error_description: "Too many." },
      { status: 429, headers: { "retry-after": "7" } },
    );
  throw new Error(`unexpected URL: ${url}`);
});

beforeEach(async () => {
  const key = await generateEs256KeyPair();
  session = {
    accessToken: "weldall-token",
    subject: "user-1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    credentials: { version: 2, issuer: ISSUER, ...key, refreshToken: "refresh" },
  };
  registry = [expenses, registryResource()];
  appsAnswer = { items: [], warnings: [], registries: [listingOf()] };
  calls = [];
  registryStatuses = [];
  fetcher.mockClear();
  vi.stubGlobal("fetch", fetcher);
});

const access = (overrides: Parameters<typeof directWeldallAccess>[0] = {}) =>
  directWeldallAccess({
    selectIssuer: async () => ISSUER,
    resolveConfig: async () => config,
    getSession: async () => session,
    ...overrides,
  });
const open = () => directOpenRegistry(config, { getSession: async () => session });
const urls = () => calls.map(({ url }) => url);
const metadataReads = () => urls().filter((url) => url.includes("/.well-known/"));
const tokenRequests = () => urls().filter((url) => url === config.token);

const found = (
  listing: AppRegistryListing[] | null,
  resources: ResourceRegistryEntry[] = [expenses, registryResource()],
): FoundRegistries => trustedRegistries(listing, resources);

describe("a registry is what Weldall lists, checked against its registration", () => {
  it("takes the API base, permissions, git route and credentials from Weldall's entry", () => {
    expect(registryFromListing(listingOf(), [registryResource()])).toEqual({
      key: "registry",
      name: "Registry registry",
      origin: ORIGIN,
      resource: registryResource(),
      api: `${ORIGIN}/api/`,
      publishScope: "registry:publish",
      publishAllowed: true,
      adminScope: "registry:admin",
      adminAllowed: false,
      git: `${ORIGIN}/git/`,
      gitCredentials: `${ORIGIN}/api/git-credentials`,
    });
  });

  it("uses the administration permission Weldall names, or none", () => {
    const resource = registryResource(
      "apps",
      ORIGIN,
      ["apps:create", "apps:it"],
      ["apps:create", "apps:it", "apps:read"],
    );
    const entry = listingOf("apps", ORIGIN, {
      scope: "apps:create",
      adminScope: "apps:it",
      adminAllowed: true,
    });
    expect(registryFromListing(entry, [resource])).toMatchObject({
      publishScope: "apps:create",
      adminScope: "apps:it",
      adminAllowed: true,
    });
    expect(
      registryFromListing({ ...entry, adminScope: null, adminAllowed: true }, [resource]),
    ).toMatchObject({ adminScope: null, adminAllowed: false });
  });

  it("counts a permission as held only when Weldall says so and grants it for the resource", () => {
    expect(
      registryFromListing(listingOf("registry", ORIGIN, { allowed: false }), [registryResource()])
        .publishAllowed,
    ).toBe(false);
    expect(
      registryFromListing(listingOf(), [registryResource("registry", ORIGIN, [])]).publishAllowed,
    ).toBe(false);
    expect(
      registryFromListing(listingOf("registry", ORIGIN, { adminAllowed: true }), [
        registryResource("registry", ORIGIN, ["registry:publish"]),
      ]).adminAllowed,
    ).toBe(false);
  });

  it("takes the real registry's shape: the git route outside the API prefix", () => {
    const resource: ResourceRegistryEntry = {
      ...registryResource(),
      resourceIdentifier: "https://registry.example.com/api",
      authorizationServer: "https://registry.example.com",
      requestPrefixes: ["https://registry.example.com/api"],
    };
    expect(
      registryFromListing(
        {
          ...listingOf(),
          resource: "https://registry.example.com/api",
          endpoint: "https://registry.example.com/api/apps",
          gitCredentials: "https://registry.example.com/api/git-credentials",
          git: "https://registry.example.com/git/",
        },
        [resource],
      ),
    ).toMatchObject({
      api: "https://registry.example.com/api/",
      git: "https://registry.example.com/git/",
      gitCredentials: "https://registry.example.com/api/git-credentials",
    });
  });

  it("reads a registry with only one of git route and credentials as not publishing changes", () => {
    for (const patch of [{ git: null }, { gitCredentials: null }])
      expect(
        registryFromListing(listingOf("registry", ORIGIN, patch), [registryResource()]),
      ).toMatchObject({ git: null, gitCredentials: null, publishScope: "registry:publish" });
  });

  it("names the mismatch when the resource identifier is on another origin than the authorization server", () => {
    expect(() =>
      registryFromListing(listingOf(), [
        { ...registryResource(), authorizationServer: "https://auth.example.com" },
      ]),
    ).toThrow(/resource identifier .* is not on the origin of its authorization server/);
    expect(() =>
      registryFromListing(listingOf("registry", ORIGIN, { gitCredentials: `${ORIGIN}/x` }), [
        registryResource(),
      ]),
    ).toThrow(
      `its git credential endpoint (${ORIGIN}/x) is not below the resource's request prefixes`,
    );
  });

  it("reads a registry that keeps apps without publishing changes", () => {
    expect(
      registryFromListing(listingOf("registry", ORIGIN, { git: null, gitCredentials: null }), [
        registryResource(),
      ]),
    ).toMatchObject({ git: null, gitCredentials: null });
  });

  it.each<[string, Partial<AppRegistryListing>, ResourceRegistryEntry[]?]>([
    ["a key Weldall lists no resource for", { key: "other" }],
    ["another resource identifier", { resource: "https://other.example/api" }],
    ["an endpoint at another origin", { endpoint: "https://evil.example/api/apps" }],
    ["an endpoint outside the request prefixes", { endpoint: `${ORIGIN}/admin/apps` }],
    ["an endpoint not ending in /apps", { endpoint: `${ORIGIN}/api/everything` }],
    ["an endpoint with credentials", { endpoint: "https://a:b@registry.example.com/api/apps" }],
    ["an endpoint with a query", { endpoint: `${ORIGIN}/api/apps?x=1` }],
    ["a plain http endpoint", { endpoint: "http://registry.example.com/api/apps" }],
    ["a publish scope Weldall does not list", { scope: "registry:everything" }],
    ["an admin scope Weldall does not list", { adminScope: "registry:everything" }],
    ["the publish scope as admin scope", { adminScope: "registry:publish" }],
    ["a git route at another origin", { git: "https://evil.example/git/" }],
    ["a git route on another path", { git: `${ORIGIN}/other/git/` }],
    ["git credentials at another origin", { gitCredentials: "https://evil.example/api/x" }],
    ["git credentials outside the request prefixes", { gitCredentials: `${ORIGIN}/x` }],
    [
      "an authorization server that is no bare origin",
      {},
      [{ ...registryResource(), authorizationServer: `${ORIGIN}/tenant` }],
    ],
  ])("refuses an entry with %s", (_case, patch, resources = [registryResource()]) => {
    expect(() => registryFromListing(listingOf("registry", ORIGIN, patch), resources)).toThrow(
      CliError,
    );
  });

  it("reports the entries it refuses, keeps the others, and refuses a key listed twice", () => {
    const second = "https://second.example.com";
    const result = found(
      [
        listingOf(),
        listingOf("second", second, { git: "https://evil.example/git/" }),
        listingOf("twice", "https://twice.example.com"),
        listingOf("twice", "https://twice.example.com"),
      ],
      [
        registryResource(),
        registryResource("second", second),
        registryResource("twice", "https://twice.example.com"),
      ],
    );
    expect(result.listed).toBe(true);
    expect(result.registries.map(({ key }) => key)).toEqual(["registry"]);
    expect(result.rejected).toEqual([
      { key: "second", reason: "its git route is not https://second.example.com/git/" },
      { key: "twice", reason: "Weldall lists it more than once" },
    ]);
    expect(found(null)).toMatchObject({ listed: false, registries: [], rejected: [] });
  });

  it("reads `registries` from Weldall's app list, null without the key, and refuses a malformed one", () => {
    expect(parseAppRegistries({ items: [], warnings: [] })).toBeNull();
    expect(parseAppRegistries({ items: [], warnings: [], registries: [] })).toEqual([]);
    expect(
      parseAppRegistries({ items: [], warnings: [], registries: [{ ...listingOf(), extra: 1 }] }),
    ).toEqual([listingOf()]);
    for (const registries of [
      "yes",
      [{ ...listingOf(), allowed: "true" }],
      [{ ...listingOf(), git: 1 }],
      [{ ...listingOf(), key: "" }],
      [{ ...listingOf(), endpoint: `${ORIGIN}/${"x".repeat(2_000)}` }],
      Array.from({ length: 101 }, (_, index) => listingOf(`r${index}`)),
    ])
      expect(() => parseAppRegistries({ items: [], warnings: [], registries })).toThrow(
        "invalid list of registries",
      );
  });

  it("accepts the bare https origins of authorization servers only", () => {
    expect(httpsOrigin("https://registry.example.com:8443")).toBe(
      "https://registry.example.com:8443",
    );
    for (const value of [
      "http://registry.example.com",
      "https://registry.example.com/x",
      "https://a@b.example",
    ])
      expect(httpsOrigin(value), value).toBeNull();
  });
});

describe("choosing a registry", () => {
  const fails = (registries: FoundRegistries, options: Parameters<typeof selectRegistry>[1]) => {
    try {
      selectRegistry(registries, options);
    } catch (error) {
      return error as { code: string; message: string; hint?: string };
    }
    throw new Error("selected");
  };
  const second = "https://second.example.com";
  const resources = [registryResource(), registryResource("second", second)];

  it("picks the named one, else the only one listed, and never one of several", () => {
    expect(selectRegistry(found([listingOf()]), { need: "changes" }).key).toBe("registry");
    const both = found([listingOf(), listingOf("second", second)], resources);
    expect(selectRegistry(both, { key: "second", need: "changes" }).origin).toBe(second);
    expect(fails(both, { need: "changes" })).toMatchObject({
      code: "registry_ambiguous",
      message: expect.stringContaining("second: Registry second at https://second.example.com"),
      details: { registries: "registry, second" },
    });
  });

  it("does not pick the only allowed one of several: names each with its key, origin and permission", () => {
    // `second` could be any resource with app discovery on and a permission many people hold.
    const one = found(
      [listingOf("registry", ORIGIN, { allowed: false }), listingOf("second", second)],
      resources,
    );
    const error = fails(one, { need: "changes" });
    expect(error).toMatchObject({
      code: "registry_ambiguous",
      hint: expect.stringContaining("--registry"),
    });
    expect(error.message).toContain(
      `registry: Registry registry at ${ORIGIN} (you lack its permission registry:publish)`,
    );
    expect(error.message).toContain(
      `second: Registry second at ${second} (you may use it for publishing apps)`,
    );
    // A listed entry the CLI refuses still counts: it may be the organisation's real registry.
    const withRejected = found(
      [listingOf(), listingOf("second", second, { git: "https://evil.example/git/" })],
      resources,
    );
    expect(fails(withRejected, { need: "changes" })).toMatchObject({
      code: "registry_ambiguous",
      message: expect.stringContaining("second: not used, it does not match its registration"),
      details: { registries: "registry" },
    });
    expect(selectRegistry(withRejected, { key: "registry", need: "changes" }).key).toBe("registry");
    // Named, the existing checks apply.
    expect(fails(one, { key: "registry", need: "changes" })).toMatchObject({
      code: "scope_missing",
      message: expect.stringContaining("registry:publish"),
    });
  });

  it("says so plainly when the organisation has not set up publishing", () => {
    expect(fails(found([]), { need: "changes" })).toMatchObject({
      code: "publishing_not_set_up",
      message: expect.stringContaining("Your organisation has not set up publishing apps"),
    });
    expect(fails(found(null), { need: "changes" })).toMatchObject({
      code: "publishing_not_set_up",
      message: expect.stringContaining("this Weldall server lists no registries"),
    });
    expect(fails(found([]), { need: "admin" }).message).toContain("administering apps");
    // An entry the CLI refuses is named, never used.
    expect(
      fails(found([listingOf("registry", ORIGIN, { git: "https://evil.example/git/" })]), {
        need: "changes",
      }),
    ).toMatchObject({
      code: "publishing_not_set_up",
      message: expect.stringContaining("registry: its git route is not"),
    });
  });

  it("names a registry that keeps apps but does not publish changes yet", () => {
    const appsOnly = found([listingOf("registry", ORIGIN, { git: null, gitCredentials: null })]);
    expect(fails(appsOnly, { need: "changes" })).toMatchObject({
      code: "publishing_not_configured",
      message: expect.stringContaining("does not publish changes to them yet"),
    });
    expect(selectRegistry(appsOnly, { need: "apps" }).key).toBe("registry");
  });

  it("tells a missing permission apart from a registry without administration", () => {
    const one = found([listingOf()]);
    expect(fails(one, { need: "admin" })).toMatchObject({
      code: "scope_missing",
      message: expect.stringContaining("registry:admin"),
    });
    const withoutAdmin = found([listingOf("registry", ORIGIN, { adminScope: null })]);
    for (const options of [{ need: "admin" as const }, { key: "registry", need: "admin" as const }])
      expect(fails(withoutAdmin, options)).toMatchObject({
        code: "administration_not_offered",
        message: expect.stringContaining("does not offer administration"),
      });
    expect(
      selectRegistry(
        found(
          [listingOf("registry", ORIGIN, { adminAllowed: true })],
          [registryResource("registry", ORIGIN, ["registry:admin"])],
        ),
        { need: "admin" },
      ).key,
    ).toBe("registry");
  });

  it("explains a missing publish permission and an unknown key", () => {
    const denied = found([listingOf("registry", ORIGIN, { allowed: false })]);
    expect(fails(denied, { need: "changes" })).toMatchObject({
      code: "scope_missing",
      message: expect.stringContaining("You lack the permission registry:publish"),
    });
    expect(fails(found([listingOf()]), { key: "nope", need: "apps" })).toMatchObject({
      code: "registry_unknown",
    });
    expect(fails(found([listingOf()]), { key: "expenses", need: "apps" }).message).toContain(
      "does not list it as a registry",
    );
    const none = found(
      [
        listingOf("registry", ORIGIN, { allowed: false }),
        listingOf("second", second, { allowed: false }),
      ],
      resources,
    );
    expect(fails(none, { need: "apps" })).toMatchObject({
      code: "registry_ambiguous",
      message: expect.stringContaining("(you lack its permission registry:publish)"),
    });
  });
});

describe("the trust decision against a stubbed Weldall", () => {
  it("never uses a resource that announces an apps API in its metadata but is not in Weldall's list", async () => {
    // `expenses` would announce itself in its metadata, and the person holds its scope.
    appsAnswer = { items: [], warnings: [], registries: [] };
    await expect(
      open()((registries) => selectRegistry(registries, { need: "changes" }), "changes"),
    ).rejects.toMatchObject({ code: "publishing_not_set_up" });
    await expect(
      access().requestCredential({ origin: EXPENSES, path: "git/acme/shop.git", access: "write" }),
    ).rejects.toMatchObject({ kind: "not_registered" });
    expect(metadataReads()).toEqual([]);
    expect(tokenRequests()).toEqual([]);
    expect(urls().some((url) => url.startsWith(EXPENSES))).toBe(false);
  });

  it("chooses the listed registry, not a self-announced one, when both exist", async () => {
    const client = await open()(
      (registries) => selectRegistry(registries, { need: "changes" }),
      "changes",
    );
    expect(client.registry.key).toBe("registry");
    expect(metadataReads()).toEqual([]);
    const exchange = new URLSearchParams(
      String(calls.find(({ url }) => url === config.token)!.init?.body),
    );
    expect(exchange.get("audience")).toBe(ORIGIN);
  });

  it.each([
    ["the route is missing (404)", null],
    ["the answer has no registries", { items: [], warnings: [] }],
  ])("treats a server where %s as not set up", async (_case, answer) => {
    appsAnswer = answer;
    for (const need of ["changes", "admin"] as const)
      await expect(
        open()((registries) => selectRegistry(registries, { need }), need),
      ).rejects.toMatchObject({
        code: "publishing_not_set_up",
        message: expect.stringContaining("this Weldall server lists no registries"),
      });
    await expect(
      access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({ kind: "not_registered" });
    expect(tokenRequests()).toEqual([]);
  });

  it("reports a malformed registry list instead of guessing", async () => {
    appsAnswer = { items: [], warnings: [], registries: [{ key: "registry" }] };
    await expect(
      open()((registries) => selectRegistry(registries, { need: "changes" }), "changes"),
    ).rejects.toThrow("invalid list of registries");
    expect(tokenRequests()).toEqual([]);
  });
});

describe("the credential helper's direct access", () => {
  it("reads Weldall's lists, gets a downstream token and asks for the credential", async () => {
    await expect(
      access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "write" }),
    ).resolves.toEqual({ status: 200, body: credential, retryAfter: null });

    // Weldall's two lists are read at once; nothing else is read before the token.
    expect(new Set(urls().slice(0, 2))).toEqual(new Set([APPS, config.scopes]));
    expect(urls().slice(2)).toEqual([
      config.token,
      `${ORIGIN}/oauth/token`,
      `${ORIGIN}/api/git-credentials`,
    ]);
    const list = calls.find(({ url }) => url === APPS)!;
    expect(list.init?.redirect).toBe("error");
    expect(new Headers(list.init?.headers).get("authorization")).toBe("DPoP weldall-token");
    const exchange = new URLSearchParams(String(calls[2]!.init?.body));
    expect(exchange.get("audience")).toBe(ORIGIN);
    expect(exchange.get("resource")).toBe(`${ORIGIN}/api`);
    expect(exchange.get("scope")).toBe("registry:publish");
    const request = calls[4]!;
    expect(request.init?.method).toBe("POST");
    expect(request.init?.redirect).toBe("error");
    expect(JSON.parse(String(request.init?.body))).toEqual({
      path: "git/acme/shop.git",
      access: "write",
    });
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("DPoP registry-token-1");
    expect(headers.get("dpop")).toMatch(/^ey/);
  });

  it.each([
    ["a host that is no registered resource", "https://evil.example.com", "git/acme/shop.git"],
    ["a registered resource Weldall does not list as a registry", EXPENSES, "git/acme/shop.git"],
    [
      "the registry's host on another port",
      "https://registry.example.com:8443",
      "git/acme/shop.git",
    ],
    ["a path outside the registry's git route", ORIGIN, "api/git-credentials"],
  ])("refuses %s before any token exists", async (_case, origin, path) => {
    await expect(
      access().requestCredential({ origin, path, access: "read" }),
    ).rejects.toMatchObject({ kind: "not_registered" });
    expect(new Set(urls())).toEqual(new Set([APPS, config.scopes]));
    expect(tokenRequests()).toEqual([]);
  });

  it("refuses a registry whose registration moved to another origin", async () => {
    registry = [registryResource("registry", "https://registry-new.example.com")];
    appsAnswer = {
      items: [],
      warnings: [],
      registries: [listingOf("registry", "https://registry-new.example.com")],
    };
    await expect(
      access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({ kind: "not_registered" });
    expect(tokenRequests()).toEqual([]);
  });

  it("refuses a registry Weldall lists without a git route, or with one it does not trust", async () => {
    for (const patch of [
      { git: null, gitCredentials: null },
      { gitCredentials: "https://evil.example/api/git-credentials" },
    ]) {
      appsAnswer = { items: [], warnings: [], registries: [listingOf("registry", ORIGIN, patch)] };
      calls = [];
      await expect(
        access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
      ).rejects.toMatchObject({ kind: "not_registered" });
      expect(urls().some((url) => url === config.token || url.includes("evil"))).toBe(false);
    }
  });

  it("refuses when the person lacks the publish permission", async () => {
    for (const [resources, listing] of [
      [[registryResource("registry", ORIGIN, [])], listingOf()],
      [[registryResource()], listingOf("registry", ORIGIN, { allowed: false })],
    ] as const) {
      registry = [...resources];
      appsAnswer = { items: [], warnings: [], registries: [listing] };
      await expect(
        access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
      ).rejects.toMatchObject({
        kind: "refused",
        message: expect.stringContaining("registry:publish"),
      });
    }
    expect(tokenRequests()).toEqual([]);
  });

  it("passes the registry's failed answers through, with Retry-After", async () => {
    const api = createRegistryApi(
      await open()((registries) => selectRegistry(registries, { need: "changes" }), "changes"),
      { sleep: async () => {} },
    );
    await expect(api.readStatus("app1")).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("no app of yours has this id"),
    });
    await expect(api.listApps()).rejects.toMatchObject({
      code: "rate_limit",
      details: { status: "429", retryAfter: "7" },
    });
    // Waited and repeated twice: three requests for the list.
    expect(calls.filter(({ url }) => url === `${ORIGIN}/api/apps`)).toHaveLength(3);
  });

  it("refuses to send a request outside the registry's resource", async () => {
    const client = await open()(
      (registries) => selectRegistry(registries, { need: "changes" }),
      "changes",
    );
    await expect(
      client.send({ method: "GET", url: `${EXPENSES}/api/x`, timeoutMs: 1_000 }),
    ).rejects.toThrow(/No registered resource accepts/);
  });

  it.each([
    [new CliError(`You are not logged in to ${ISSUER}`), "login"],
    [new CliError("invalid_grant: refresh token expired"), "login"],
    [new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }), "network"],
  ])("reports a session failure as %s", async (error, kind) => {
    await expect(
      access({
        getSession: async () => {
          throw error;
        },
      }).requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({ kind });
    expect(calls).toEqual([]);
  });

  it("reports configuration and transport failures", async () => {
    await expect(
      access({
        resolveConfig: async () => {
          throw new ConfigurationError("Weldall discovery failed with HTTP 500");
        },
      }).requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({ kind: "configuration" });
    await expect(
      access({
        resolveConfig: async () => {
          throw new ConfigurationError(`Unable to reach ${ISSUER}`, {
            cause: new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }),
          });
        },
      }).requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({ kind: "network", message: "fetch failed: connect ECONNREFUSED" });
    await expect(
      access({ selectIssuer: async () => null }).requestCredential({
        origin: ORIGIN,
        path: "git/acme/shop.git",
        access: "read",
      }),
    ).rejects.toMatchObject({ kind: "configuration" });
    fetcher.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    });
    await expect(
      access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({ kind: "network", message: "fetch failed: getaddrinfo ENOTFOUND" });
  });
});

describe("a downstream token that expires during a run", () => {
  const openChanges = () =>
    open()((registries) => selectRegistry(registries, { need: "changes" }), "changes");

  it("gets a fresh token once on a 401 and repeats the request", async () => {
    const api = createRegistryApi(await openChanges(), { sleep: async () => {} });
    registryStatuses = [401];
    await expect(api.readStatus("app1")).rejects.toMatchObject({ code: "not_found" });
    const status = calls.filter(({ url }) => url === `${ORIGIN}/api/apps/app1/status`);
    expect(status).toHaveLength(2);
    expect(new Headers(status[1]!.init?.headers).get("authorization")).toBe(
      "DPoP registry-token-2",
    );
    expect(tokenRequests()).toHaveLength(2);
  });

  it("tells the person to log in only when the fresh token is refused too", async () => {
    const api = createRegistryApi(await openChanges(), { sleep: async () => {} });
    registryStatuses = [401, 401];
    await expect(api.readStatus("app1")).rejects.toMatchObject({
      code: "login",
      hint: expect.stringContaining("weldall login"),
    });
    expect(calls.filter(({ url }) => url === `${ORIGIN}/api/apps/app1/status`)).toHaveLength(2);
  });

  it("reports an expired login when no fresh token can be had", async () => {
    let sessions = 0;
    const client = await directOpenRegistry(config, {
      getSession: async () => {
        sessions += 1;
        if (sessions > 1) throw new CliError("invalid_grant: refresh token expired");
        return session;
      },
    })((registries) => selectRegistry(registries, { need: "changes" }), "changes");
    registryStatuses = [401];
    await expect(
      createRegistryApi(client, { sleep: async () => {} }).readStatus("app1"),
    ).rejects.toMatchObject({ code: "login", hint: expect.stringContaining("weldall login") });
  });

  it("stops when Weldall names another registry meanwhile", async () => {
    const client = await openChanges();
    registryStatuses = [401];
    appsAnswer = {
      items: [],
      warnings: [],
      registries: [listingOf("registry", ORIGIN, { endpoint: `${ORIGIN}/api/v2/apps` })],
    };
    await expect(
      client.send({ method: "GET", url: `${ORIGIN}/api/apps/app1/status`, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ kind: "refused", message: expect.stringContaining("changed") });
  });
});

describe("a registry that does not answer in time", () => {
  it("is a timeout with the repeat hint, through the real client", async () => {
    const client = await open()(
      (registries) => selectRegistry(registries, { need: "changes" }),
      "changes",
    );
    fetcher.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    // A real `AbortSignal.timeout` deadline passing.
    await expect(
      client.send({ method: "GET", url: `${ORIGIN}/api/apps`, timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: "timeout" });

    fetcher.mockImplementationOnce(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expect(
      createRegistryApi(client, { sleep: async () => {} }).createApp({
        template: "react",
        name: "x",
        description: "y",
      }),
    ).rejects.toMatchObject({
      code: "timeout",
      message: "Creating the app: the registry did not answer in time.",
      hint: "Run the same command again; it continues where it stopped.",
    });
  });
});

describe("Retry-After", () => {
  it("reads seconds and HTTP dates", () => {
    expect(retryAfterSeconds("12")).toBe(12);
    expect(retryAfterSeconds(" 0 ")).toBe(0);
    expect(retryAfterSeconds(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThan(25);
    expect(retryAfterSeconds("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(0);
    expect(retryAfterSeconds("soon")).toBeNull();
    expect(retryAfterSeconds(null)).toBeNull();
  });
});
