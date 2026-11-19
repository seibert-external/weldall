import { cli } from "gunshi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceRegistryEntry } from "@weldall/sdk";

/** `weldall app checklist`: the Git app's set-up checklist (was `weldall connectors check`). */
const ORIGIN = "https://git-app.example.com";
const mocks = vi.hoisted(() => ({
  registry: [] as unknown[],
  requests: [] as Array<{ origin: string; scope: string; path: string }>,
  answer: { status: 200, body: null as unknown },
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
          async send({ path }: { path: string }) {
            mocks.requests.push({ origin: gitApp.origin, scope, path });
            return mocks.answer;
          },
        };
      },
  };
});
import { appCommand, mainCommand } from "../src/commands.js";
import {
  CHECKLIST_FAILED_EXIT_CODE,
  formatChecklist,
  requiredCheckFailed,
  type ChecklistReport,
} from "../src/publish/checklist.js";

const gitApp = (key: string, origin: string, grantedScopes: string[]): ResourceRegistryEntry => ({
  key,
  name: `Git app ${key}`,
  resourceIdentifier: `${origin}/api`,
  authorizationServer: origin,
  downstreamClientId: "weldall-cli-at-git-app",
  requestPrefixes: [`${origin}/api`],
  supportedScopes: ["git-app:admin", "git-app:publish"],
  grantedScopes,
});
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
  mocks.registry = [];
  process.exitCode = undefined;
});

describe("weldall app checklist", () => {
  it("asks the only Git app the administrator may check, with the admin scope, one line per check", async () => {
    mocks.registry = [gitApp("git-app", ORIGIN, ["git-app:admin", "git-app:publish"])];
    mocks.answer = { status: 200, body: answer };
    const text = await runChecklist([]);
    expect(mocks.requests).toEqual([
      { origin: ORIGIN, scope: "git-app:admin", path: "admin/checklist" },
    ]);
    expect(text).toBe(
      [
        'Checks for Git app "git-app" (github, organisation acme)',
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

  it("names one of several Git apps and an app for the repository checks; prints JSON", async () => {
    mocks.registry = [
      gitApp("git-app-github", ORIGIN, ["git-app:admin"]),
      gitApp("git-app-forgejo", "https://forgejo-app.example.com", ["git-app:admin"]),
    ];
    const passing = {
      ...answer,
      repository: { owner: "acme", name: "app-expenses" },
      checks: answer.checks.filter(({ state }) => state !== "fail"),
      summary: { pass: 1, fail: 0, unverifiable: 1 },
    };
    mocks.answer = { status: 200, body: passing };
    expect(
      JSON.parse(await runChecklist(["--git-app=git-app-forgejo", "--app=app 1", "--json"])),
    ).toEqual({ gitApp: { key: "git-app-forgejo", name: "Git app git-app-forgejo" }, ...passing });
    expect(mocks.requests).toEqual([
      {
        origin: "https://forgejo-app.example.com",
        scope: "git-app:admin",
        path: "admin/checklist?app=app%201",
      },
    ]);
    expect(process.exitCode).toBeUndefined();

    expect(JSON.parse(await runChecklist(["--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "git_app_ambiguous", hint: expect.stringContaining("--git-app") },
    });
  });

  it("explains a missing admin scope before asking the Git app", async () => {
    mocks.registry = [gitApp("git-app", ORIGIN, ["git-app:publish"])];
    expect(JSON.parse(await runChecklist(["--json"]))).toMatchObject({
      outcome: "error",
      error: { code: "scope_missing", message: expect.stringContaining("git-app:admin") },
    });
    expect(mocks.requests).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [404, "<html>Not found</html>", "git_app_unsupported", "does not offer this"],
    [
      404,
      { error: "not_found", error_description: "No app of this Git app has this id." },
      "not_found",
      "No app of this Git app",
    ],
    [
      403,
      { error: "access_denied", error_description: "You may no longer use Weldall." },
      "access_denied",
      "HTTP 403",
    ],
    [
      503,
      { error: "audit_unavailable", error_description: "Audit log down." },
      "audit_unavailable",
      "Audit log down.",
    ],
    [200, { checks: "nope" }, "git_app_unsupported", "unexpected answer"],
  ])("reports HTTP %i clearly", async (status, body, code, message) => {
    mocks.registry = [gitApp("git-app", ORIGIN, ["git-app:admin"])];
    mocks.answer = { status, body };
    expect(JSON.parse(await runChecklist(["--json"]))).toMatchObject({
      outcome: "error",
      error: { code, message: expect.stringContaining(message) },
    });
  });

  it("keeps Git app texts terminal-safe and counts only required failures", () => {
    const report = {
      gitApp: { key: "git-app", name: "Git app" },
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
