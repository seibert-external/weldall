import { stripVTControlCharacters } from "node:util";
import { cli } from "gunshi";
import { afterEach, describe, expect, it, vi } from "vitest";

/** `weldall app list` and `weldall app confirm` against a server with the app registry. */
const ISSUER = "https://weldall.example.com";
const mocks = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; path: string }>,
  answers: [] as Array<{ status: number; body: unknown }>,
}));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  resolveWeldallConfig: vi.fn(async () => ({ issuer: ISSUER })),
}));
vi.mock("../src/publish/weldall-api.js", async (original) => {
  const actual = await original<typeof import("../src/publish/weldall-api.js")>();
  return {
    ...actual,
    directPublishApi: () =>
      actual.createPublishApi(ISSUER, async ({ method, path }) => {
        mocks.requests.push({ method, path });
        return mocks.answers.shift()!;
      }),
  };
});
import { appCommand, mainCommand } from "../src/commands.js";

const entry = (id: string, name: string, state: string, expiresAt: string) => ({
  id,
  name,
  purpose: "Track team expenses",
  repository: { connector: "github", owner: "acme", name: `app-${name}`, webUrl: null },
  template: "react",
  links: { preview: null, live: null },
  createdAt: "2026-08-01T10:00:00.000Z",
  confirmedAt: null,
  expiresAt,
  state,
});
const list = {
  apps: [
    entry("app1", "visitors", "expired", "2026-11-10T10:00:00.000Z"),
    entry("app2", "rooms", "expiring_soon", "2026-11-25T10:00:00.000Z"),
    entry("app3", "expenses", "active", "2027-02-01T10:00:00.000Z"),
  ],
  reverificationDays: 90,
  expiringSoonDays: 14,
};

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
  mocks.answers.length = 0;
  process.exitCode = undefined;
});

describe("weldall app list and confirm", () => {
  it("prints the list as JSON for agents", async () => {
    mocks.answers.push({ status: 200, body: list });
    expect(JSON.parse(await run(["app", "list", "--json"]))).toEqual({ outcome: "apps", ...list });
    expect(mocks.requests).toEqual([{ method: "GET", path: "apps" }]);
  });

  it("prints a readable table and says how to confirm", async () => {
    mocks.answers.push({ status: 200, body: list });
    const text = await run(["app", "list"]);
    expect(text).toContain("Your apps");
    expect(text).toMatch(/visitors\s+expired\s+2026-11-10\s+acme\/app-visitors\s+app1/);
    expect(text).toMatch(/rooms\s+expiring soon\s+2026-11-25/);
    expect(text.replace(/[\s│]+/g, " ")).toContain("Run `weldall app confirm <id>`");
  });

  it("says when there are no apps", async () => {
    mocks.answers.push({ status: 200, body: { ...list, apps: [] } });
    expect(await run(["app", "list"])).toContain("no apps in Weldall's app registry");
  });

  it("confirms an app by id and prints the new expiry", async () => {
    const confirmed = {
      ...entry("app1", "visitors", "active", "2027-02-16T09:00:00.000Z"),
      confirmedAt: "2026-11-18T09:00:00.000Z",
    };
    mocks.answers.push(
      { status: 200, body: { app: confirmed } },
      { status: 200, body: { app: confirmed } },
    );
    expect(await run(["app", "confirm", "app1"])).toContain(
      "Confirmed visitors (app1) as still needed until 2027-02-16.",
    );
    expect(JSON.parse(await run(["app", "confirm", "app1", "--json"]))).toEqual({
      outcome: "confirmed",
      app: confirmed,
    });
    expect(mocks.requests).toEqual([
      { method: "POST", path: "apps/app1/confirm" },
      { method: "POST", path: "apps/app1/confirm" },
    ]);
  });

  it("reports someone else's or an unknown app as JSON error with exit code 1", async () => {
    mocks.answers.push({
      status: 404,
      body: { error: "not_found", error_description: "No app of yours has this id." },
    });
    expect(JSON.parse(await run(["app", "confirm", "other", "--json"]))).toEqual({
      outcome: "error",
      error: {
        code: "not_found",
        message: "Confirming the app failed (HTTP 404): No app of yours has this id.",
      },
    });
    expect(process.exitCode).toBe(1);
  });
});
