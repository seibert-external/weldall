import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { formatAppEntry, formatAppWarning } from "../src/commands.js";
import { listApps, parseAppList } from "../src/services/apps.js";

const state = vi.hoisted(() => ({ session: null as any }));
vi.mock("../src/services/auth.js", () => ({
  withAccess: async (_config: unknown, operation: (session: unknown) => Promise<unknown>) =>
    operation(state.session),
}));

const issuer = "https://weldall.example.com";
const config: WeldallConfig = {
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
};

beforeEach(async () => {
  const key = await generateEs256KeyPair();
  state.session = {
    accessToken: "access-a",
    subject: "account-a",
    credentials: {
      version: 2,
      issuer,
      ...key,
      refreshToken: "refresh-a",
      accessSession: {
        accessToken: "access-a",
        subject: "account-a",
        expiresAt: Math.floor(Date.now() / 1_000) + 600,
      },
    },
  };
  vi.unstubAllGlobals();
});

const serve = (response: () => Response) => {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

const app = {
  id: "registry.app_1",
  sourceId: "app_1",
  name: "Expense tracker",
  description: "Tracks travel expenses",
  own: false,
  hasOwner: true,
  ownerName: "Olivia Owner",
  scopes: ["finance:user"],
  repository: { name: "finance/expenses", url: "https://git.example.com/finance/expenses" },
  url: "https://expenses.example.com/",
  revision: 1,
  createdAt: "2026-11-19T09:30:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2027-02-18T10:00:00.000Z",
  expired: false,
  source: { type: "resource", key: "registry", name: "Registry" },
};
const empty = { items: [], warnings: [] };

describe("app list", () => {
  it("accepts what GET /api/me/apps serves", () => {
    const list = {
      items: [
        app,
        { ...app, own: true, ownerName: null },
        { ...app, hasOwner: false, ownerName: null, repository: null, url: null },
      ],
      warnings: [{ source: "registry", code: "apps_skipped", count: 2 }],
    };
    expect(parseAppList(list)).toEqual(list);
  });

  it("accepts the answer with the registries newer servers list, and without them", async () => {
    const registries = [
      {
        key: "registry",
        name: "Registry",
        resource: "https://registry.example.com/api",
        endpoint: "https://registry.example.com/api/apps",
        scope: "registry:publish",
        allowed: true,
        adminScope: null,
        adminAllowed: false,
        git: "https://registry.example.com/git/",
        gitCredentials: "https://registry.example.com/api/git-credentials",
      },
    ];
    for (const body of [
      { items: [app], warnings: [], registries },
      { items: [app], warnings: [], registries: [] },
      { items: [app], warnings: [] },
    ]) {
      expect(parseAppList(body).items).toEqual([app]);
      serve(() => Response.json(body));
      await expect(listApps(config)).resolves.toMatchObject({ items: [app], warnings: [] });
    }
  });

  it.each([
    ["no object", []],
    ["no items", { ...empty, items: undefined }],
    ["an app without a name", { ...empty, items: [{ ...app, name: undefined }] }],
    ["an app without hasOwner", { ...empty, items: [{ ...app, hasOwner: undefined }] }],
    ["an app without a repository key", { ...empty, items: [{ ...app, repository: undefined }] }],
    [
      "a repository without a URL",
      { ...empty, items: [{ ...app, repository: { name: "finance/expenses" } }] },
    ],
    ["an app without a url key", { ...empty, items: [{ ...app, url: undefined }] }],
    ["a non-string url", { ...empty, items: [{ ...app, url: 1 }] }],
    ["an app without expiresAt", { ...empty, items: [{ ...app, expiresAt: null }] }],
    ["a source without a key", { ...empty, items: [{ ...app, source: { type: "resource" } }] }],
    ["a malformed warning", { ...empty, warnings: ["catalog_expired"] }],
    ["no warnings", { items: [] }],
  ])("refuses %s", (_name, value) => {
    expect(() => parseAppList(value)).toThrow("invalid app list");
  });
});

describe("app list request", () => {
  it("passes the server's answer through", async () => {
    const body = { items: [app], warnings: [] };
    const fetch = serve(() => Response.json(body));

    await expect(listApps(config)).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith(`${issuer}/api/me/apps`, expect.anything());
  });

  it.each([
    ["an empty 404", () => new Response(null, { status: 404 })],
    ["a 404 page", () => new Response("<html>Not found</html>", { status: 404 })],
    ["a JSON 404", () => Response.json({ error: "not_found" }, { status: 404 })],
  ])("reports a server without app discovery that answers %s", async (_name, response) => {
    serve(response);

    const failure = listApps(config);
    await expect(failure).rejects.toThrow("This Weldall server does not offer apps.");
    await expect(failure).rejects.toMatchObject({
      hint: "App discovery needs a newer Weldall server.",
    });
  });

  it("names the app list, not the skill registry, when another request fails", async () => {
    serve(() => Response.json({ error: "HTTP 404 upstream" }, { status: 500 }));

    const failure = listApps(config);
    await expect(failure).rejects.toThrow(/^Weldall app list request failed with HTTP 500/);
    await expect(failure).rejects.not.toThrow("does not offer apps");
  });
});

describe("app list output", () => {
  it("shows link, owner, repository, purpose, and the created and review dates", () => {
    expect(formatAppEntry(app)).toBe(
      [
        "registry.app_1  ·  Expense tracker  ·  https://expenses.example.com/  ·  owner Olivia Owner" +
          "  ·  repository finance/expenses  ·  shared with finance:user" +
          "  ·  created 2026-11-19 09:30 UTC  ·  review by 2027-02-18 10:00 UTC",
        "  Tracks travel expenses",
      ].join("\n"),
    );
  });

  it("names apps without link, owner or repository, and marks own ones and those due for review", () => {
    expect(
      formatAppEntry({
        ...app,
        hasOwner: false,
        ownerName: null,
        repository: null,
        url: null,
        scopes: [],
        description: "",
        expired: true,
      }),
    ).toBe(
      "registry.app_1  ·  Expense tracker  ·  no link  ·  no owner  ·  no repository" +
        "  ·  shared with nobody  ·  created 2026-11-19 09:30 UTC  ·  review due since 2027-02-18 10:00 UTC",
    );
    expect(formatAppEntry({ ...app, own: true, description: "" })).toContain("  ·  yours  ·  ");
  });

  it("neutralizes control characters in everything the server sent", () => {
    const esc = "\u001b";
    const bel = "\u0007";
    const output = formatAppEntry({
      ...app,
      id: `registry.app_1${esc}[2J`,
      name: `Tracker${esc}]8;;https://attacker.example.com${bel}click${esc}]8;;${bel}`,
      url: `https://expenses.example.com/${esc}[31m`,
      ownerName: `Olivia${esc}[31m Owner`,
      repository: { name: `finance/${esc}[1mexpenses`, url: "https://git.example.com" },
      scopes: [`finance:user${"\u009b"}0m`],
      createdAt: `not a date${esc}[H`,
      description: `Line one\nline two\t${esc}]52;c;cGF5bG9hZA==${bel}red${"\u007f"}`,
    });

    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(output).toBe(
      [
        "registry.app_1\uFFFD[2J  ·  Tracker\uFFFD]8;;https://attacker.example.com\uFFFDclick\uFFFD]8;;\uFFFD" +
          "  ·  https://expenses.example.com/\uFFFD[31m  ·  owner Olivia\uFFFD[31m Owner" +
          "  ·  repository finance/\uFFFD[1mexpenses  ·  shared with finance:user\uFFFD0m" +
          "  ·  created not a date\uFFFD[H  ·  review by 2027-02-18 10:00 UTC",
        "  Line one line two \uFFFD]52;c;cGF5bG9hZA==\uFFFDred\uFFFD",
      ].join("\n"),
    );
  });

  it("neutralizes control characters in warnings", () => {
    expect(
      formatAppWarning({ source: "registry\u001b[2J", code: "catalog_expired\u001b]0;x\u0007" }),
    ).toBe("Apps from registry\uFFFD[2J: catalog_expired\uFFFD]0;x\uFFFD");
  });

  it("names why Weldall refused a resource's apps API, sanitised, and parses the extra field", () => {
    const warning = {
      source: "registry",
      code: "apps_api_refused",
      refusal: "git_invalid\u001b[2J",
    };
    expect(parseAppList({ items: [], warnings: [warning] }).warnings).toEqual([warning]);
    expect(formatAppWarning(warning)).toBe(
      "Apps from registry: apps_api_refused (git_invalid\uFFFD[2J)",
    );
  });
});
