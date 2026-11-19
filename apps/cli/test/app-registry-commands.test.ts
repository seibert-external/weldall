import { stripVTControlCharacters } from "node:util";
import { cli } from "gunshi";
import { afterEach, describe, expect, it, vi } from "vitest";

/** `weldall app list` and `weldall app confirm` against the Git apps that keep the registry. */
const GITHUB = "https://git-github.example.com";
const FORGEJO = "https://git-forgejo.example.com";
const mocks = vi.hoisted(() => ({
  registry: [] as unknown[],
  requests: [] as Array<{ origin: string; scope: string; method: string; path: string }>,
  /** Answers per Git app origin, in order. */
  answers: {} as Record<string, Array<{ status: number; body: unknown }>>,
}));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  resolveWeldallConfig: vi.fn(async () => ({ issuer: "https://weldall.example.com" })),
}));
vi.mock("../src/git/weldall-access.js", async (original) => {
  const actual = await original<typeof import("../src/git/weldall-access.js")>();
  // The real choice runs on the test's registry; only the token part is left out.
  return {
    ...actual,
    directOpenGitApp:
      () => async (choose: (resources: never[]) => { origin: string }, scope: string) => {
        const gitApp = choose(mocks.registry as never[]);
        return {
          gitApp,
          async send({ method, path }: { method: string; path: string }) {
            mocks.requests.push({ origin: gitApp.origin, scope, method, path });
            return mocks.answers[gitApp.origin]!.shift()!;
          },
        };
      },
  };
});
import { appCommand, mainCommand } from "../src/commands.js";

const gitApp = (key: string, origin: string, granted = ["git-app:publish"]) => ({
  key,
  name: key,
  resourceIdentifier: `${origin}/api`,
  authorizationServer: origin,
  downstreamClientId: "weldall-cli-at-git-app",
  requestPrefixes: [`${origin}/api`],
  supportedScopes: ["git-app:admin", "git-app:publish"],
  grantedScopes: granted,
});
/** An entry as the Git app answers it (without the resource key the CLI adds). */
const entry = (id: string, name: string, state: string, expiresAt: string) => ({
  id,
  name,
  purpose: "Track team expenses",
  repository: { owner: "acme", name: `app-${name}`, webUrl: null },
  template: "react",
  links: { preview: null, live: null },
  createdAt: "2026-08-01T10:00:00.000Z",
  confirmedAt: null as string | null,
  expiresAt,
  state,
});
const list = (...apps: ReturnType<typeof entry>[]) => ({
  resource: `${GITHUB}/api`,
  apps,
  reverificationDays: 90,
  expiringSoonDays: 14,
});
const visitors = entry("app1", "visitors", "expired", "2026-11-10T10:00:00.000Z");
const rooms = entry("app2", "rooms", "expiring_soon", "2026-11-25T10:00:00.000Z");
const expenses = entry("app3", "expenses", "active", "2027-02-01T10:00:00.000Z");
/** The entry as the CLI prints it: with the Git app's resource key. */
const shown = (app: object & { repository: object }, resource = "git-github") => ({
  ...app,
  repository: { resource, ...app.repository },
});

async function run(argv: string[]) {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await cli(argv, mainCommand, {
      name: "weldall",
      version: "0.0.0",
      description: "test",
      strict: true,
      subCommands: { app: appCommand },
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
  mocks.registry = [];
  mocks.answers = {};
  process.exitCode = undefined;
});

describe("weldall app list and confirm", () => {
  it("lists the apps of every Git app the person may publish with, earliest expiry first", async () => {
    mocks.registry = [
      gitApp("git-github", GITHUB),
      gitApp("git-forgejo", FORGEJO),
      gitApp("git-other", "https://git-other.example.com", []),
    ];
    mocks.answers = {
      [GITHUB]: [{ status: 200, body: list(rooms, expenses) }],
      [FORGEJO]: [{ status: 200, body: { ...list(visitors), resource: `${FORGEJO}/api` } }],
    };
    expect(JSON.parse(await run(["app", "list", "--json"]))).toEqual({
      outcome: "apps",
      apps: [shown(visitors, "git-forgejo"), shown(rooms), shown(expenses)],
      reverificationDays: 90,
      expiringSoonDays: 14,
    });
    expect(mocks.requests).toEqual([
      { origin: GITHUB, scope: "git-app:publish", method: "GET", path: "apps" },
      { origin: FORGEJO, scope: "git-app:publish", method: "GET", path: "apps" },
    ]);
  });

  it("prints a readable table and says how to confirm", async () => {
    mocks.registry = [gitApp("git-github", GITHUB)];
    mocks.answers = { [GITHUB]: [{ status: 200, body: list(visitors, rooms, expenses) }] };
    const text = await run(["app", "list"]);
    expect(text).toContain("Your apps");
    expect(text).toMatch(/visitors\s+expired\s+2026-11-10\s+acme\/app-visitors\s+app1/);
    expect(text).toMatch(/rooms\s+expiring soon\s+2026-11-25/);
    expect(text.replace(/[\s│]+/g, " ")).toContain("Run `weldall app confirm <id>`");
  });

  it("says when there are no apps", async () => {
    mocks.registry = [gitApp("git-github", GITHUB)];
    mocks.answers = { [GITHUB]: [{ status: 200, body: list() }] };
    expect(await run(["app", "list"])).toContain("no apps in the app registry");
  });

  it("names a missing permission instead of listing nothing", async () => {
    mocks.registry = [gitApp("git-github", GITHUB, [])];
    expect(JSON.parse(await run(["app", "list", "--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "scope_missing", message: expect.stringContaining("git-app:publish") },
    });
    expect(mocks.requests).toEqual([]);
  });

  it("confirms an app by id at the only Git app and prints the new expiry", async () => {
    mocks.registry = [gitApp("git-github", GITHUB)];
    const confirmed = {
      ...entry("app1", "visitors", "active", "2027-02-16T09:00:00.000Z"),
      confirmedAt: "2026-11-18T09:00:00.000Z",
    };
    mocks.answers = {
      [GITHUB]: [
        { status: 200, body: { app: confirmed } },
        { status: 200, body: { app: confirmed } },
      ],
    };
    expect(await run(["app", "confirm", "app1"])).toContain(
      "Confirmed visitors (app1) as still needed until 2027-02-16.",
    );
    expect(JSON.parse(await run(["app", "confirm", "app1", "--json"]))).toEqual({
      outcome: "confirmed",
      app: shown(confirmed),
    });
    expect(mocks.requests).toEqual([
      { origin: GITHUB, scope: "git-app:publish", method: "POST", path: "apps/app1/confirm" },
      { origin: GITHUB, scope: "git-app:publish", method: "POST", path: "apps/app1/confirm" },
    ]);
  });

  it("confirms at the Git app whose registry lists the app, or the one --git-app names", async () => {
    mocks.registry = [gitApp("git-github", GITHUB), gitApp("git-forgejo", FORGEJO)];
    mocks.answers = {
      [GITHUB]: [{ status: 200, body: list(rooms) }],
      [FORGEJO]: [
        { status: 200, body: list(visitors) },
        { status: 200, body: { app: visitors } },
        { status: 200, body: { app: visitors } },
      ],
    };
    expect(JSON.parse(await run(["app", "confirm", "app1", "--json"]))).toEqual({
      outcome: "confirmed",
      app: shown(visitors, "git-forgejo"),
    });
    expect(
      JSON.parse(await run(["app", "confirm", "app1", "--git-app=git-forgejo", "--json"])),
    ).toMatchObject({ outcome: "confirmed" });
    expect(mocks.requests.map(({ origin, path }) => `${origin} ${path}`)).toEqual([
      `${GITHUB} apps`,
      `${FORGEJO} apps`,
      `${FORGEJO} apps/app1/confirm`,
      `${FORGEJO} apps/app1/confirm`,
    ]);
  });

  it("says when none of several Git apps lists the app", async () => {
    mocks.registry = [gitApp("git-github", GITHUB), gitApp("git-forgejo", FORGEJO)];
    mocks.answers = {
      [GITHUB]: [{ status: 200, body: list(rooms) }],
      [FORGEJO]: [{ status: 200, body: list(visitors) }],
    };
    expect(JSON.parse(await run(["app", "confirm", "app9", "--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "not_found", message: expect.stringContaining("git-github, git-forgejo") },
    });
  });

  it("reports someone else's or an unknown app as JSON error with exit code 1", async () => {
    mocks.registry = [gitApp("git-github", GITHUB)];
    mocks.answers = {
      [GITHUB]: [
        {
          status: 404,
          body: { error: "not_found", error_description: "No app of yours has this id." },
        },
      ],
    };
    expect(JSON.parse(await run(["app", "confirm", "other", "--json"]))).toEqual({
      outcome: "error",
      error: {
        code: "not_found",
        message: "Confirming the app failed (HTTP 404): No app of yours has this id.",
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it("says when a Git app does not keep a registry yet", async () => {
    mocks.registry = [gitApp("git-github", GITHUB)];
    mocks.answers = { [GITHUB]: [{ status: 404, body: "<html>Not Found</html>" }] };
    expect(JSON.parse(await run(["app", "list", "--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "git_app_unsupported", hint: expect.stringContaining("update the Git app") },
    });
  });
});
