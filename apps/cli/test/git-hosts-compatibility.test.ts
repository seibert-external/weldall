import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "gunshi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cross-version: this CLI against a Weldall server released before Git hosts. Such a server has
 * no `/api/me/apps`, `/api/me/git-credentials` or connector check route and answers them with
 * Next's HTML 404 page. Each new command must say so clearly, with a stable code and exit code,
 * and change nothing locally.
 */
const ISSUER = "https://weldall.example.com";
const mocks = vi.hoisted(() => ({
  paths: [] as string[],
}));
const olderServer = async ({ path }: { path: string }) => {
  mocks.paths.push(path);
  return { status: 404, body: "<!DOCTYPE html><title>404: This page could not be found.</title>" };
};
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  resolveWeldallConfig: vi.fn(async () => ({ issuer: ISSUER })),
}));
vi.mock("../src/publish/weldall-api.js", async (original) => {
  const actual = await original<typeof import("../src/publish/weldall-api.js")>();
  return { ...actual, directPublishApi: () => actual.createPublishApi(ISSUER, olderServer) };
});
vi.mock("../src/connector-check.js", async (original) => ({
  ...(await original<typeof import("../src/connector-check.js")>()),
  directConnectorCheckSend: () => async (path: string) => olderServer({ path }),
}));
import { appCommand, connectorsCommand, mainCommand } from "../src/commands.js";

async function run(argv: string[]) {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await cli(argv, mainCommand, {
      name: "weldall",
      version: "0.0.0",
      description: "test",
      strict: true,
      subCommands: { app: appCommand, connectors: connectorsCommand },
      renderHeader: null,
      renderValidationErrors: null,
    });
    return JSON.parse(output.mock.calls.flat().join("\n"));
  } finally {
    output.mockRestore();
  }
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "weldall-older-server-"));
  git(folder, ["init", "-q", "-b", "main"]);
  await writeFile(join(folder, "README.md"), "# Template\n");
  git(folder, ["add", "-A"]);
  git(folder, ["commit", "-q", "-m", "Template"]);
  git(folder, ["config", "weldall.template", "react"]);
  git(folder, ["config", "weldall.templateCommit", git(folder, ["rev-parse", "HEAD"])]);
  await writeFile(join(folder, "app.ts"), "export const app = 1;\n");
});
afterEach(async () => {
  mocks.paths.length = 0;
  process.exitCode = undefined;
  await rm(folder, { recursive: true, force: true });
});

describe("this CLI against a server without Git hosts", () => {
  it("app publish fails with server_unsupported and leaves the folder as it was", async () => {
    const head = git(folder, ["rev-parse", "HEAD"]);
    const before = git(folder, ["status", "--porcelain"]);
    const result = await run([
      "app",
      "publish",
      `--dir=${folder}`,
      "--name=expenses",
      "--purpose=Track expenses",
      "--json",
    ]);
    expect(result).toEqual({
      outcome: "error",
      error: expect.objectContaining({
        code: "server_unsupported",
        message: expect.stringContaining("this Weldall server cannot publish apps"),
        hint: expect.stringContaining("update the server"),
      }),
    });
    expect(process.exitCode).toBe(1);
    expect(mocks.paths).toEqual(["apps"]);
    // Nothing was committed, recorded or configured: the folder can publish after an upgrade.
    expect(git(folder, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(folder, ["status", "--porcelain"])).toBe(before);
    expect(git(folder, ["for-each-ref", "refs/weldall"])).toBe("");
    expect(git(folder, ["config", "--get-regexp", "^weldall\\."]).split("\n").sort()).toEqual(
      [`weldall.template react`, `weldall.templatecommit ${head}`].sort(),
    );
    expect(git(folder, ["remote"])).toBe("");
  });

  it("app status fails with server_unsupported", async () => {
    const result = await run(["app", "status", "--app=app1", "--json"]);
    expect(result).toMatchObject({ outcome: "error", error: { code: "server_unsupported" } });
    expect(process.exitCode).toBe(1);
  });

  it("connectors check explains that the server cannot check connectors", async () => {
    const result = await run(["connectors", "check", "github", "--json"]);
    expect(result).toEqual({
      outcome: "error",
      error: {
        message: "This Weldall server cannot check connectors.",
        hint: expect.stringContaining("update the server"),
      },
    });
    expect(process.exitCode).toBe(1);
  });
});
