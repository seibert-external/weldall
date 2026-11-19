import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair, type ResourceRegistryEntry } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { CliError, ConfigurationError } from "../src/errors.js";
import type { AccessSession } from "../src/services/session-manager.js";

/**
 * The direct access of the git credential helper and of publish: the real downstream flow
 * (registry, token exchange at Weldall, downstream token at the Git app, DPoP request) against
 * a stubbed `fetch`. Only the ID-JAG signature check is replaced.
 */
vi.mock("../src/oauth/session.js", async (original) => ({
  ...(await original<typeof import("../src/oauth/session.js")>()),
  validateIdJagResponse: async () => "downstream-assertion",
}));
import { asGitApp, GIT_APP_SCOPES, httpsOrigin, selectGitApp } from "../src/git/git-apps.js";
import { directOpenGitApp, directWeldallAccess } from "../src/git/weldall-access.js";
import { createGitAppApi } from "../src/publish/git-app-api.js";

const ISSUER = "https://weldall.example.com";
const ORIGIN = "https://git-app.example.com";
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
const gitAppResource = (
  key = "git-app",
  origin = ORIGIN,
  grantedScopes = ["git-app:publish"],
): ResourceRegistryEntry => ({
  key,
  name: `Git app ${key}`,
  resourceIdentifier: `${origin}/api`,
  authorizationServer: origin,
  downstreamClientId: "weldall-cli-at-git-app",
  requestPrefixes: [`${origin}/api`],
  supportedScopes: ["git-app:admin", "git-app:publish"],
  grantedScopes,
});
const expenses: ResourceRegistryEntry = {
  key: "expenses",
  name: "Expenses",
  resourceIdentifier: "https://expenses.example.com/api",
  authorizationServer: "https://expenses.example.com",
  downstreamClientId: "weldall-cli-at-expenses",
  requestPrefixes: ["https://expenses.example.com/api"],
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
let calls: Array<{ url: string; init: RequestInit | undefined }>;
const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  if (url === config.scopes) return Response.json(registry);
  if (url === config.token) return Response.json({ access_token: "id-jag" });
  if (url.endsWith("/oauth/token"))
    return Response.json({ token_type: "DPoP", access_token: "git-app-token", expires_in: 300 });
  if (url === `${ORIGIN}/api/git-credentials`) return Response.json(credential);
  if (url === `${ORIGIN}/api/apps/app1/status`)
    return Response.json({ error: "not_found", error_description: "No app." }, { status: 404 });
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
  registry = [expenses, gitAppResource()];
  calls = [];
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

describe("recognising Git apps in Weldall's registry", () => {
  it("takes a resource with the publish scope and a bare https authorization server", () => {
    expect(asGitApp(gitAppResource())).toMatchObject({ key: "git-app", origin: ORIGIN });
    expect(asGitApp(expenses)).toBeNull();
    expect(asGitApp(gitAppResource(), GIT_APP_SCOPES.admin)?.origin).toBe(ORIGIN);
    expect(httpsOrigin("https://git-app.example.com:8443")).toBe(
      "https://git-app.example.com:8443",
    );
    for (const value of [
      "http://git-app.example.com",
      "https://git-app.example.com/x",
      "https://a@b.example",
    ])
      expect(httpsOrigin(value), value).toBeNull();
  });

  it("picks the named one, else the only one granted, and explains every other case", () => {
    const other = gitAppResource("git-app-forgejo", "https://forgejo-app.example.com");
    expect(selectGitApp([expenses, gitAppResource()], { scope: "git-app:publish" }).key).toBe(
      "git-app",
    );
    expect(
      selectGitApp([gitAppResource(), gitAppResource("x", "https://x.example", [])], {
        scope: "git-app:publish",
      }).key,
    ).toBe("git-app");
    expect(
      selectGitApp([gitAppResource(), other], { key: "git-app-forgejo", scope: "git-app:publish" })
        .origin,
    ).toBe("https://forgejo-app.example.com");
    const fails = (
      resources: ResourceRegistryEntry[],
      options: Parameters<typeof selectGitApp>[1],
    ) => {
      try {
        selectGitApp(resources, options);
      } catch (error) {
        return error as { code: string; message: string };
      }
      throw new Error("selected");
    };
    expect(fails([expenses], { scope: "git-app:publish" })).toMatchObject({ code: "no_git_app" });
    expect(fails([], { scope: "git-app:admin" }).message).toContain("check a Git host");
    expect(fails([gitAppResource(), other], { scope: "git-app:publish" })).toMatchObject({
      code: "git_app_ambiguous",
    });
    expect(fails([gitAppResource()], { key: "expenses", scope: "git-app:publish" })).toMatchObject({
      code: "git_app_unknown",
    });
    expect(
      fails([expenses, gitAppResource()], { key: "expenses", scope: "git-app:publish" }).message,
    ).toContain("is not a Git app");
    expect(fails([gitAppResource()], { scope: "git-app:admin" })).toMatchObject({
      code: "scope_missing",
      message: expect.stringContaining("git-app:admin"),
    });
    expect(
      fails([gitAppResource("a", ORIGIN, []), gitAppResource("b", "https://b.example", [])], {
        scope: "git-app:publish",
      }),
    ).toMatchObject({ code: "scope_missing" });
  });
});

describe("the credential helper's direct access", () => {
  it("gets a downstream token for the registered Git app and asks it for the credential", async () => {
    await expect(
      access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "write" }),
    ).resolves.toEqual({ status: 200, body: credential });

    expect(calls.map(({ url }) => url)).toEqual([
      config.scopes,
      config.token,
      `${ORIGIN}/oauth/token`,
      `${ORIGIN}/api/git-credentials`,
    ]);
    const exchange = new URLSearchParams(String(calls[1]!.init?.body));
    expect(exchange.get("audience")).toBe(ORIGIN);
    expect(exchange.get("resource")).toBe(`${ORIGIN}/api`);
    expect(exchange.get("scope")).toBe("git-app:publish");
    const request = calls[3]!;
    expect(request.init?.method).toBe("POST");
    expect(request.init?.redirect).toBe("error");
    expect(JSON.parse(String(request.init?.body))).toEqual({
      path: "git/acme/shop.git",
      access: "write",
    });
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("DPoP git-app-token");
    expect(headers.get("dpop")).toMatch(/^ey/);
  });

  it.each([
    ["a host that is no registered resource", "https://evil.example.com"],
    ["a registered resource that is not a Git app", "https://expenses.example.com"],
    ["the Git app's host on another port", "https://git-app.example.com:8443"],
  ])("refuses %s before any token exists", async (_case, origin) => {
    await expect(
      access().requestCredential({ origin, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({ kind: "not_registered" });
    expect(calls.map(({ url }) => url)).toEqual([config.scopes]);
  });

  it("refuses a Git app whose registration moved to another origin", async () => {
    registry = [gitAppResource("git-app", "https://git-app-new.example.com")];
    await expect(
      access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({ kind: "not_registered" });
    expect(calls).toHaveLength(1);
  });

  it("refuses when the person lacks the publish scope", async () => {
    registry = [gitAppResource("git-app", ORIGIN, [])];
    await expect(
      access().requestCredential({ origin: ORIGIN, path: "git/acme/shop.git", access: "read" }),
    ).rejects.toMatchObject({
      kind: "refused",
      message: expect.stringContaining("git-app:publish"),
    });
    expect(calls).toHaveLength(1);
  });

  it("passes the Git app's failed answers through for the protocol code to explain", async () => {
    fetcher.mockImplementationOnce(async (input) => {
      calls.push({ url: String(input), init: undefined });
      return Response.json(registry);
    });
    const open = directOpenGitApp(config, { getSession: async () => session });
    const api = createGitAppApi(
      await open(
        (resources) => selectGitApp(resources, { scope: "git-app:publish" }),
        "git-app:publish",
      ),
    );
    await expect(api.readStatus("app1")).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("HTTP 404"),
    });
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
