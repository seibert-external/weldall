import { stripVTControlCharacters } from "node:util";
import { cli } from "gunshi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "../src/git/registries.js";
import { foundOf, registryOf } from "./fixtures/registry-objects.js";

/**
 * `weldall app list`, `confirm`, `list --all` and `set-owner` against the registries that keep
 * the apps; the real choice runs, only the token part is left out.
 */
const FIRST = "https://registry.example.com";
const SECOND = "https://registry-two.example.com";
const mocks = vi.hoisted(() => ({
  registries: [] as unknown[],
  requests: [] as Array<{
    origin: string;
    scope: string;
    method: string;
    path: string;
    body?: unknown;
  }>,
  /** Answers per registry origin, in order. */
  answers: {} as Record<
    string,
    Array<{ status: number; body: unknown; retryAfter?: number | null }>
  >,
}));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  resolveWeldallConfig: vi.fn(async () => ({ issuer: "https://weldall.example.com" })),
}));
vi.mock("node:timers/promises", async (original) => ({
  ...(await original<typeof import("node:timers/promises")>()),
  // Repeats after a rate limit do not wait in tests.
  setTimeout: vi.fn(async () => undefined),
}));
vi.mock("../src/git/weldall-access.js", async (original) => {
  const actual = await original<typeof import("../src/git/weldall-access.js")>();
  return {
    ...actual,
    directOpenRegistry:
      () =>
      async (
        choose: (found: ReturnType<typeof foundOf>) => Registry,
        need: "admin" | "admin-changes" | "apps" | "changes",
      ) => {
        const registry = choose(foundOf(mocks.registries as Registry[]));
        const scope = need.startsWith("admin") ? registry.adminScope! : registry.publishScope;
        return {
          registry,
          async send({ method, url, body }: { method: string; url: string; body?: unknown }) {
            const target = new URL(url);
            mocks.requests.push({
              origin: target.origin,
              scope,
              method,
              path: `${target.pathname}${target.search}`,
              ...(body === undefined ? {} : { body }),
            });
            const answer = mocks.answers[target.origin]!.shift()!;
            return { retryAfter: null, ...answer };
          },
        };
      },
  };
});
import { appsCommand, mainCommand } from "../src/commands.js";
import { appCommand } from "../src/app-commands.js";

/** An app as the registry answers it to its owner. */
const entry = (id: string, name: string, state: string, expiresAt: string) => ({
  id,
  name,
  description: "Track team expenses",
  scopes: ["sales:member"],
  url: null as string | null,
  repository: { name: `acme/app-${name}`, url: `https://github.example/acme/app-${name}` },
  template: "react",
  revision: 1,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  confirmedAt: null as string | null,
  expiresAt,
  state,
  removedAt: null as string | null,
  removedReason: null as string | null,
});
const list = (...apps: ReturnType<typeof entry>[]) => ({
  resource: `${FIRST}/api`,
  apps,
  reverificationDays: 90,
  expiringSoonDays: 14,
});
const visitors = entry("app_1", "visitors", "expired", "2026-11-10T10:00:00.000Z");
const rooms = entry("app_2", "rooms", "expiring_soon", "2026-11-25T10:00:00.000Z");
const expenses = entry("app_3", "expenses", "active", "2027-02-01T10:00:00.000Z");
/** The app as the CLI prints it: with the registry's resource key. */
const shown = (app: object, registry = "first") => ({ ...app, registry });
const notFound = {
  status: 404,
  body: { error: "not_found", error_description: "No app of yours has this id." },
};

async function run(argv: string[]) {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await cli(argv, mainCommand, {
      name: "weldall",
      version: "0.0.0",
      description: "test",
      strict: true,
      subCommands: { app: appCommand, apps: appsCommand },
      renderHeader: null,
      renderValidationErrors: null,
    });
    return stripVTControlCharacters(output.mock.calls.flat().join("\n"));
  } finally {
    output.mockRestore();
  }
}

afterEach(() => {
  mocks.requests.length = 0;
  mocks.registries = [];
  mocks.answers = {};
  process.exitCode = undefined;
});

describe("weldall app list and confirm", () => {
  it("lists the apps of every registry the person may use, earliest review first", async () => {
    mocks.registries = [
      registryOf("first", FIRST, ["registry:publish"]),
      registryOf("second", SECOND, ["registry:publish"], { changes: false }),
      registryOf("other", "https://other.example.com", []),
    ];
    mocks.answers = {
      [FIRST]: [{ status: 200, body: list(rooms, expenses) }],
      [SECOND]: [{ status: 200, body: { ...list(visitors), resource: `${SECOND}/api` } }],
    };
    expect(JSON.parse(await run(["app", "list", "--json"]))).toEqual({
      outcome: "apps",
      apps: [shown(visitors, "second"), shown(rooms), shown(expenses)],
      reverificationDays: 90,
      expiringSoonDays: 14,
    });
    expect(mocks.requests).toEqual([
      { origin: FIRST, scope: "registry:publish", method: "GET", path: "/api/apps" },
      { origin: SECOND, scope: "registry:publish", method: "GET", path: "/api/apps" },
    ]);
  });

  it("prints a readable table with review dates and says how to confirm", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:publish"])];
    mocks.answers = {
      [FIRST]: [
        {
          status: 200,
          body: list(visitors, rooms, { ...expenses, removedAt: "2026-11-01T00:00:00.000Z" }),
        },
      ],
    };
    const text = await run(["app", "list"]);
    expect(text).toContain("Your apps");
    expect(text).toMatch(/visitors\s+review due since 2026-11-10\s+acme\/app-visitors\s+app_1/);
    expect(text).toMatch(/rooms\s+review by 2026-11-25 \(soon\)/);
    expect(text).toMatch(/expenses \(not listed\)\s+review by 2027-02-01/);
    expect(text).not.toContain("expired");
    const flat = text.replace(/[\s│]+/g, " ");
    expect(flat).toContain("Run `weldall app confirm <id>`");
    expect(flat).toContain("a due review is only flagged, the app keeps working");
    expect(flat).toContain("Publishing a fix brings them back");
  });

  it("says when there are no apps, and where the shared ones are", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:publish"])];
    mocks.answers = { [FIRST]: [{ status: 200, body: list() }] };
    const text = (await run(["app", "list"])).replace(/[\s│]+/g, " ");
    expect(text).toContain("no apps of your own");
    expect(text).toContain("`weldall apps` lists the apps shared with you");
  });

  it("names a missing permission instead of listing nothing", async () => {
    mocks.registries = [registryOf("first", FIRST, [])];
    expect(JSON.parse(await run(["app", "list", "--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "scope_missing", message: expect.stringContaining("registry:publish") },
    });
    expect(mocks.requests).toEqual([]);
  });

  it("says plainly when the organisation has no registry", async () => {
    mocks.registries = [];
    expect(JSON.parse(await run(["app", "list", "--json"]))).toMatchObject({
      outcome: "error",
      error: {
        code: "publishing_not_set_up",
        message: expect.stringContaining("Your organisation has not set up publishing apps"),
      },
    });
  });

  it("confirms an app by id at the only registry and prints the next review", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:publish"])];
    const confirmed = {
      ...entry("app_1", "visitors", "active", "2027-02-16T09:00:00.000Z"),
      confirmedAt: "2026-11-18T09:00:00.000Z",
    };
    mocks.answers = {
      [FIRST]: [
        { status: 200, body: { app: confirmed } },
        { status: 200, body: { app: confirmed } },
      ],
    };
    expect((await run(["app", "confirm", "app_1"])).replace(/[\s│]+/g, " ")).toContain(
      "Confirmed visitors (app_1) as still needed; next review by 2027-02-16.",
    );
    expect(JSON.parse(await run(["app", "confirm", "app_1", "--json"]))).toEqual({
      outcome: "confirmed",
      app: shown(confirmed),
    });
    expect(mocks.requests).toEqual([
      { origin: FIRST, scope: "registry:publish", method: "POST", path: "/api/apps/app_1/confirm" },
      { origin: FIRST, scope: "registry:publish", method: "POST", path: "/api/apps/app_1/confirm" },
    ]);
  });

  it("confirms at the registry that has the app, or the one --registry names", async () => {
    mocks.registries = [
      registryOf("first", FIRST, ["registry:publish"]),
      registryOf("second", SECOND, ["registry:publish"]),
    ];
    mocks.answers = {
      [FIRST]: [notFound],
      [SECOND]: [
        { status: 200, body: { app: visitors } },
        { status: 200, body: { app: visitors } },
        { status: 200, body: { app: visitors } },
      ],
    };
    expect(JSON.parse(await run(["app", "confirm", "app_1", "--json"]))).toEqual({
      outcome: "confirmed",
      app: shown(visitors, "second"),
    });
    expect(
      JSON.parse(await run(["app", "confirm", "app_1", "--registry=second", "--json"])),
    ).toMatchObject({ outcome: "confirmed" });
    expect(mocks.requests.map(({ origin, method, path }) => `${origin} ${method} ${path}`)).toEqual(
      [
        `${FIRST} GET /api/apps/app_1`,
        `${SECOND} GET /api/apps/app_1`,
        `${SECOND} POST /api/apps/app_1/confirm`,
        `${SECOND} POST /api/apps/app_1/confirm`,
      ],
    );
  });

  it("says when none of several registries has the app", async () => {
    mocks.registries = [
      registryOf("first", FIRST, ["registry:publish"]),
      registryOf("second", SECOND, ["registry:publish"]),
    ];
    mocks.answers = { [FIRST]: [notFound], [SECOND]: [notFound] };
    expect(JSON.parse(await run(["app", "confirm", "app_9", "--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "not_found", message: expect.stringContaining("first, second") },
    });
  });

  it("reports someone else's or an unknown app as JSON error with exit code 1", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:publish"])];
    mocks.answers = { [FIRST]: [notFound] };
    expect(JSON.parse(await run(["app", "confirm", "other", "--json"]))).toEqual({
      outcome: "error",
      error: {
        code: "not_found",
        message: "Confirming the app: no app of yours has this id (No app of yours has this id.).",
        hint: "`weldall app list` shows your apps and their ids.",
        details: { status: "404" },
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it("never sends an id that is not one to the registry", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:publish"])];
    expect(JSON.parse(await run(["app", "confirm", "../admin", "--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "invalid_app_id" },
    });
    expect(mocks.requests).toEqual([]);
  });

  it("waits a short Retry-After and repeats, then reports how long to wait", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:publish"])];
    const limited = { status: 429, body: { error: "rate_limit" }, retryAfter: 3 };
    mocks.answers = { [FIRST]: [limited, { status: 200, body: list(expenses) }] };
    expect(JSON.parse(await run(["app", "list", "--json"]))).toMatchObject({ outcome: "apps" });
    mocks.answers = { [FIRST]: [limited, limited, limited] };
    expect(JSON.parse(await run(["app", "list", "--json"]))).toMatchObject({
      outcome: "error",
      error: {
        code: "rate_limit",
        message: "Listing your apps: too many requests in a short time.",
        hint: "Wait about 3 seconds, then try again.",
        details: { status: "429", retryAfter: "3" },
      },
    });
    expect(mocks.requests).toHaveLength(5);
  });

  it("says when a registry does not offer apps yet", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:publish"])];
    mocks.answers = { [FIRST]: [{ status: 404, body: "<html>Not Found</html>" }] };
    expect(JSON.parse(await run(["app", "list", "--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "registry_unsupported", hint: expect.stringContaining("update the registry") },
    });
  });
});

describe("administrators: weldall app list --all and set-owner", () => {
  const administered = (app: ReturnType<typeof entry>, owner: string | null) => ({
    ...app,
    owner,
    ownerAssignedBy: null,
    ownerAssignedAt: null,
    confirmedBy: null,
  });
  const page = (...apps: ReturnType<typeof administered>[]) => ({
    resource: `${FIRST}/api`,
    apps,
    total: 3,
    page: 1,
    pageSize: 2,
    reverificationDays: 90,
    expiringSoonDays: 14,
  });

  it("lists every app with the admin permission and passes the filters on", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:admin", "registry:publish"])];
    const found = administered(visitors, null);
    mocks.answers = { [FIRST]: [{ status: 200, body: page(found) }] };
    expect(
      JSON.parse(
        await run([
          "app",
          "list",
          "--all",
          "--state=expired",
          "--without-owner",
          "--page-size=2",
          "--json",
        ]),
      ),
    ).toEqual({
      outcome: "all_apps",
      registry: "first",
      ...page(shown(found) as never),
      resource: undefined,
    });
    expect(mocks.requests).toEqual([
      {
        origin: FIRST,
        scope: "registry:admin",
        method: "GET",
        path: "/api/admin/apps?pageSize=2&state=expired&owner=none",
      },
    ]);
  });

  it("prints owners, flags apps without one and points to the next page", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:admin"])];
    mocks.answers = {
      [FIRST]: [
        {
          status: 200,
          body: page(administered(visitors, null), administered(expenses, "user-7")),
        },
      ],
    };
    const text = (await run(["app", "list", "--all"])).replace(/[\s│]+/g, " ");
    expect(text).toContain("visitors no owner review due since 2026-11-10");
    expect(text).toContain("expenses user-7 review by 2027-02-01");
    expect(text).toContain("More apps: add --page 2.");
    expect(text).toContain("weldall app set-owner <id> --owner <Weldall user id>");
  });

  it("refuses the filters without --all and a missing admin permission", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:publish"])];
    expect(JSON.parse(await run(["app", "list", "--without-owner", "--json"]))).toMatchObject({
      outcome: "error",
      error: { message: expect.stringContaining("need --all") },
    });
    expect(JSON.parse(await run(["app", "list", "--all", "--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "scope_missing", message: expect.stringContaining("registry:admin") },
    });
    expect(JSON.parse(await run(["app", "list", "--all", "--state=gone", "--json"]))).toMatchObject(
      { outcome: "error", error: { message: expect.stringContaining("--state") } },
    );
    expect(mocks.requests).toEqual([]);
  });

  it("assigns an owner and explains a refused one", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:admin"])];
    const assigned = administered(visitors, "user-7");
    mocks.answers = {
      [FIRST]: [
        { status: 200, body: { app: assigned } },
        {
          status: 409,
          body: {
            error: "owner_not_allowed",
            error_description:
              "The owner lacks the permission registry:publish, which they need to confirm the app. Assign it in Weldall first.",
          },
        },
      ],
    };
    expect(
      (await run(["app", "set-owner", "app_1", "--owner", "user-7"])).replace(/[\s│]+/g, " "),
    ).toContain("visitors (app_1) now belongs to user-7. Its review date stays 2026-11-10.");
    expect(mocks.requests).toEqual([
      {
        origin: FIRST,
        scope: "registry:admin",
        method: "PUT",
        path: "/api/admin/apps/app_1/owner",
        body: { owner: "user-7" },
      },
    ]);
    expect(
      JSON.parse(await run(["app", "set-owner", "app_1", "--owner", "user-8", "--json"])),
    ).toMatchObject({
      outcome: "error",
      error: {
        code: "owner_not_allowed",
        message: expect.stringContaining("that person cannot own the app"),
        hint: expect.stringContaining("weldall whoami --json"),
      },
    });
  });

  it("refuses an email address as owner before asking the registry", async () => {
    mocks.registries = [registryOf("first", FIRST, ["registry:admin"])];
    expect(
      JSON.parse(
        await run(["app", "set-owner", "app_1", "--owner", "someone@example.com", "--json"]),
      ),
    ).toMatchObject({ outcome: "error", error: { code: "invalid_owner" } });
    expect(mocks.requests).toEqual([]);
  });
});

describe("weldall app next to weldall apps", () => {
  it("tells the two apart in their help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await cli(["--help"], mainCommand, {
        name: "weldall",
        version: "0.0.0",
        description: "test",
        subCommands: { app: appCommand, apps: appsCommand },
        renderHeader: null,
      });
      const help = stripVTControlCharacters(log.mock.calls.flat().join("\n"));
      expect(help).toMatch(
        /app\s.*Create and publish your own apps.*`weldall apps` lists the apps shared with you/,
      );
      expect(help).toMatch(
        /apps\s.*List apps you own or that are shared.*`weldall app` creates and publishes your own/,
      );
    } finally {
      log.mockRestore();
    }
  });
});
