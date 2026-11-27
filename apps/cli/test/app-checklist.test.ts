import { cli } from "gunshi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "../src/git/registries.js";
import { foundOf, registryOf } from "./fixtures/registry-objects.js";

/** `weldall app checklist`: the registry's set-up checklist of its Git host. */
const ORIGIN = "https://registry.example.com";
const mocks = vi.hoisted(() => ({
  registries: [] as unknown[],
  requests: [] as Array<{ origin: string; scope: string; path: string }>,
  answer: { status: 200, body: null as unknown, retryAfter: null as number | null },
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
          async send({ url }: { url: string }) {
            const target = new URL(url);
            mocks.requests.push({
              origin: target.origin,
              scope,
              path: `${target.pathname}${target.search}`,
            });
            return mocks.answer;
          },
        };
      },
  };
});
import { mainCommand } from "../src/commands.js";
import { appCommand } from "../src/app-commands.js";
import {
  CHECKLIST_FAILED_EXIT_CODE,
  formatChecklist,
  requiredCheckFailed,
  type ChecklistReport,
} from "../src/publish/checklist.js";

const registry = (key: string, origin: string, grantedScopes: string[]) =>
  registryOf(key, origin, grantedScopes);
const answer = {
  host: { kind: "github", organization: "acme" },
  repository: null,
  checks: [
    {
      id: "app-authentication",
      title: "App authentication",
      state: "pass",
      required: true,
      reason: 'GitHub accepted the App\'s JWT (App "weldall-app", ID 123456).',
      action: null,
    },
    {
      id: "permissions.pull-requests",
      title: "Permissions: open pull requests",
      state: "fail",
      required: true,
      reason: "The installation lacks Repository permissions > Pull requests: Read and write.",
      action: "In the App's settings on GitHub (Permissions & events), grant it.",
    },
    {
      id: "branch-rule",
      title: "Default-branch rule",
      state: "unverifiable",
      required: false,
      reason: "Cannot verify before a repository exists.",
      action: "Recommended: an organisation ruleset.",
    },
  ],
  summary: { pass: 1, fail: 1, unverifiable: 1 },
};

async function runChecklist(args: string[]) {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await cli(["app", "checklist", ...args], mainCommand, {
      name: "weldall",
      version: "0.0.0",
      description: "test",
      strict: true,
      subCommands: { app: appCommand },
      renderHeader: null,
      renderValidationErrors: null,
    });
    return output.mock.calls.flat().join("\n");
  } finally {
    output.mockRestore();
  }
}

afterEach(() => {
  mocks.requests.length = 0;
  mocks.registries = [];
  process.exitCode = undefined;
});

describe("weldall app checklist", () => {
  it("asks the only registry the administrator may check, with the admin scope, one line per check", async () => {
    mocks.registries = [registry("registry", ORIGIN, ["registry:admin", "registry:publish"])];
    mocks.answer = { status: 200, body: answer, retryAfter: null };
    const text = await runChecklist([]);
    expect(mocks.requests).toEqual([
      { origin: ORIGIN, scope: "registry:admin", path: "/api/admin/checklist" },
    ]);
    expect(text).toBe(
      [
        'Checks for registry "registry" (github, organisation acme)',
        "No app was named: checks that need a repository cannot be verified (add --app <id>).",
        "",
        `PASS           App authentication: GitHub accepted the App's JWT (App "weldall-app", ID 123456).`,
        "FAIL           Permissions: open pull requests: The installation lacks Repository permissions > Pull requests: Read and write.",
        "               To do: In the App's settings on GitHub (Permissions & events), grant it.",
        "CANNOT VERIFY  Default-branch rule (recommended): Cannot verify before a repository exists.",
        "               To do: Recommended: an organisation ruleset.",
        "",
        "1 passed, 1 failed, 1 cannot be verified.",
      ].join("\n"),
    );
    expect(process.exitCode).toBe(CHECKLIST_FAILED_EXIT_CODE);
  });

  it("names one of several registries and an app for the repository checks; prints JSON", async () => {
    mocks.registries = [
      registry("registry-github", ORIGIN, ["registry:admin"]),
      registry("registry-second", "https://second.example.com", ["registry:admin"]),
    ];
    const passing = {
      ...answer,
      repository: { owner: "acme", name: "app-expenses" },
      checks: answer.checks.filter(({ state }) => state !== "fail"),
      summary: { pass: 1, fail: 0, unverifiable: 1 },
    };
    mocks.answer = { status: 200, body: passing, retryAfter: null };
    expect(
      JSON.parse(await runChecklist(["--registry=registry-second", "--app=app 1", "--json"])),
    ).toEqual({
      registry: { key: "registry-second", name: "Registry registry-second" },
      ...passing,
    });
    expect(mocks.requests).toEqual([
      {
        origin: "https://second.example.com",
        scope: "registry:admin",
        path: "/api/admin/checklist?app=app%201",
      },
    ]);
    expect(process.exitCode).toBeUndefined();

    expect(JSON.parse(await runChecklist(["--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "registry_ambiguous", hint: expect.stringContaining("--registry") },
    });
  });

  it("explains a missing admin scope before asking the registry", async () => {
    mocks.registries = [registry("registry", ORIGIN, ["registry:publish"])];
    expect(JSON.parse(await runChecklist(["--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "scope_missing", message: expect.stringContaining("registry:admin") },
    });
    expect(mocks.requests).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [404, "<html>Not found</html>", "registry_unsupported", "does not offer this"],
    [
      404,
      { error: "not_found", error_description: "No app has this id." },
      "not_found",
      "No app has this id.",
    ],
    [
      403,
      { error: "access_denied", error_description: "You may no longer use Weldall." },
      "access_denied",
      "the registry refused the request (You may no longer use Weldall.)",
    ],
    [
      409,
      { error: "publishing_not_configured", error_description: "No reviewer team." },
      "publishing_not_configured",
      "does not create apps or publish changes yet (No reviewer team.)",
    ],
    [
      503,
      { error: "audit_unavailable", error_description: "Audit log down." },
      "audit_unavailable",
      "Audit log down.",
    ],
    [200, { checks: "nope" }, "registry_unsupported", "unexpected answer"],
  ])("reports HTTP %i clearly", async (status, body, code, message) => {
    mocks.registries = [registry("registry", ORIGIN, ["registry:admin"])];
    mocks.answer = { status, body, retryAfter: null };
    expect(JSON.parse(await runChecklist(["--json"]))).toMatchObject({
      outcome: "error",
      error: { code, message: expect.stringContaining(message) },
    });
  });

  it("keeps registry texts terminal-safe and counts only required failures", () => {
    const report = {
      registry: { key: "registry", name: "Registry" },
      ...answer,
      repository: { owner: "acme-apps", name: "app-expenses" },
      checks: [{ ...answer.checks[0]!, reason: "line\u001b[31mred" }],
    } as ChecklistReport;
    const text = formatChecklist(report);
    expect(text).toContain("used acme-apps/app-expenses.");
    expect(text).not.toContain("\u001b");
    expect(
      requiredCheckFailed({
        ...report,
        checks: [{ ...answer.checks[2]!, state: "fail" }],
      } as ChecklistReport),
    ).toBe(false);
  });
});
