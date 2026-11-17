import { cli } from "gunshi";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn<(path: string) => Promise<{ status: number; body: unknown }>>(),
}));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  resolveWeldallConfig: vi.fn(async () => ({ issuer: "https://weldall.example.com" })),
}));
vi.mock("../src/connector-check.js", async (original) => ({
  ...(await original<typeof import("../src/connector-check.js")>()),
  directConnectorCheckSend: () => mocks.send,
}));
import { connectorsCommand, mainCommand } from "../src/commands.js";
import {
  CONNECTOR_CHECK_FAILED_EXIT_CODE,
  formatConnectorCheck,
  readConnectorCheck,
  requiredCheckFailed,
  type ConnectorCheckReport,
} from "../src/connector-check.js";

const report: ConnectorCheckReport = {
  connector: { key: "github", name: "GitHub", type: "github-app" },
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
const answer = (status: number, body: unknown) => async () => ({ status, body });

async function runCheck(args: string[]) {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await cli(["connectors", "check", ...args], mainCommand, {
      name: "weldall",
      version: "0.0.0",
      description: "test",
      strict: true,
      subCommands: { connectors: connectorsCommand },
      renderHeader: null,
      renderValidationErrors: null,
    });
    return output.mock.calls.flat().join("\n");
  } finally {
    output.mockRestore();
  }
}

afterEach(() => {
  mocks.send.mockReset();
  process.exitCode = undefined;
});

describe("weldall connectors check", () => {
  it("asks the admin endpoint of the connector and prints one line per check", async () => {
    mocks.send.mockImplementation(answer(200, report));
    const text = await runCheck(["github"]);
    expect(mocks.send).toHaveBeenCalledWith("/api/admin/connectors/github/check");
    expect(text).toBe(
      [
        'Checks for connector "github" (github-app)',
        "No app repository exists yet: checks that need one cannot be verified.",
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
    expect(process.exitCode).toBe(CONNECTOR_CHECK_FAILED_EXIT_CODE);
  });

  it("prints the report as JSON and exits 0 when only recommendations fail", async () => {
    const passing = {
      ...report,
      checks: report.checks.filter(({ state }) => state !== "fail"),
      summary: { pass: 1, fail: 0, unverifiable: 1 },
    };
    mocks.send.mockImplementation(answer(200, passing));
    expect(JSON.parse(await runCheck(["github", "--json"]))).toEqual(passing);
    expect(process.exitCode).toBeUndefined();
    expect(
      requiredCheckFailed({
        ...passing,
        checks: [{ ...passing.checks[1]!, state: "fail" }],
      }),
    ).toBe(false);
  });

  it("explains an older server that has no connector checks, also as JSON", async () => {
    mocks.send.mockImplementation(answer(404, "<html>Not found</html>"));
    expect(JSON.parse(await runCheck(["github", "--json"]))).toEqual({
      outcome: "error",
      error: {
        message: "This Weldall server cannot check connectors.",
        hint: expect.stringContaining("update the server"),
      },
    });
    expect(process.exitCode).toBe(1);
    for (const status of [404, 405])
      await expect(
        readConnectorCheck({ connector: "github", send: answer(status, null) }),
      ).rejects.toThrow("This Weldall server cannot check connectors.");
  });

  it.each([
    [401, { error: "unauthorized" }, "Your Weldall login has expired."],
    [403, { error: "forbidden", error_description: "Administrator required." }, "administrators"],
    [404, { error: "not_found" }, 'There is no connector "github".'],
    [
      400,
      { error: "unsupported_provider", error_description: "This connector is not a Git host." },
      "Checking the connector failed (HTTP 400): This connector is not a Git host.",
    ],
    [200, { checks: "nope" }, "unexpected answer"],
  ])("reports HTTP %i clearly", async (status, body, message) => {
    await expect(
      readConnectorCheck({ connector: "github", send: answer(status, body) }),
    ).rejects.toThrow(message);
  });

  it("keeps server texts terminal-safe", () => {
    const text = formatConnectorCheck({
      ...report,
      repository: { owner: "acme-apps", name: "app-expenses" },
      checks: [{ ...report.checks[0]!, reason: "line\u001b[31mred" }],
    });
    expect(text).toContain("used acme-apps/app-expenses.");
    expect(text).not.toContain("\u001b");
  });
});
