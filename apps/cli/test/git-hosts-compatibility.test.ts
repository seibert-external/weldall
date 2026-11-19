import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "gunshi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair, type ResourceRegistryEntry } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";

/**
 * Cross-version: this CLI against a Weldall server released before Git apps (it has the resource
 * registry, but no Git app is registered and there is no `/api/me/apps`, which it answers with
 * Next's HTML 404 page), and against a current server where no Git app is registered. Each
 * command must say so clearly, with a stable code and exit code, ask no token for anything, and
 * change nothing locally. The real direct code runs; only the login and `fetch` are stand-ins.
 */
const ISSUER = "https://weldall.example.com";
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
const mocks = vi.hoisted(() => ({
  urls: [] as string[],
  session: null as unknown,
  registry: [] as unknown[],
}));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  resolveWeldallConfig: vi.fn(async () => config),
}));
vi.mock("../src/services/session-manager.js", async (original) => ({
  ...(await original<typeof import("../src/services/session-manager.js")>()),
  SessionManager: class {
    async getAccessSession() {
      return mocks.session;
    }
  },
}));
import { appCommand, connectorsCommand, mainCommand } from "../src/commands.js";

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
beforeAll(async () => {
  mocks.session = {
    accessToken: "weldall-token",
    subject: "user-1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    credentials: {
      version: 2,
      issuer: ISSUER,
      ...(await generateEs256KeyPair()),
      refreshToken: "r",
    },
  };
});
beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      mocks.urls.push(url);
      if (url === config.scopes) return Response.json(mocks.registry);
      return new Response("<!DOCTYPE html><title>404: This page could not be found.</title>", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    }),
  );
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
  mocks.urls.length = 0;
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  await rm(folder, { recursive: true, force: true });
});

describe.each([
  ["an older server (no Git app, no app registry)", []],
  ["a current server without a registered Git app", [expenses]],
])("this CLI against %s", (_case, registry) => {
  beforeEach(() => {
    mocks.registry = registry;
  });

  it("app publish fails with no_git_app, asks for no token and leaves the folder as it was", async () => {
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
        code: "no_git_app",
        message: expect.stringContaining("No Git app is registered in Weldall"),
        hint: expect.stringContaining("Weldall administrator"),
      }),
    });
    expect(process.exitCode).toBe(1);
    expect(mocks.urls).toEqual([config.scopes]);
    // Nothing was committed, recorded or configured: the folder can publish once one exists.
    expect(git(folder, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(folder, ["status", "--porcelain"])).toBe(before);
    expect(git(folder, ["for-each-ref", "refs/weldall"])).toBe("");
    expect(git(folder, ["config", "--get-regexp", "^weldall\\."]).split("\n").sort()).toEqual(
      [`weldall.template react`, `weldall.templatecommit ${head}`].sort(),
    );
    expect(git(folder, ["remote"])).toBe("");
  });

  it("app checklist fails with no_git_app", async () => {
    const result = await run(["app", "checklist", "--json"]);
    expect(result).toMatchObject({
      outcome: "error",
      error: { code: "no_git_app", message: expect.stringContaining("check a Git host") },
    });
    expect(process.exitCode).toBe(1);
    expect(mocks.urls).toEqual([config.scopes]);
  });

  it("app publish with --git-app names what Weldall lists instead", async () => {
    const result = await run([
      "app",
      "publish",
      `--dir=${folder}`,
      "--git-app=git-app",
      "--name=expenses",
      "--purpose=Track expenses",
      "--json",
    ]);
    expect(result).toMatchObject({ outcome: "error", error: { code: "git_app_unknown" } });
  });
});

describe("this CLI against an older server", () => {
  beforeEach(() => {
    mocks.registry = [];
  });

  it("app status of an app id says that the server has no app registry", async () => {
    const result = await run(["app", "status", "--app=app1", "--json"]);
    expect(result).toMatchObject({
      outcome: "error",
      error: { code: "server_unsupported", message: expect.stringContaining("no app registry") },
    });
    expect(process.exitCode).toBe(1);
  });

  it("app list and app confirm say that the server has no app registry", async () => {
    for (const argv of [
      ["app", "list", "--json"],
      ["app", "confirm", "app1", "--json"],
    ]) {
      process.exitCode = undefined;
      expect(await run(argv)).toEqual({
        outcome: "error",
        error: expect.objectContaining({
          code: "server_unsupported",
          message: expect.stringContaining("this Weldall server has no app registry"),
          hint: expect.stringContaining("update the server"),
        }),
      });
      expect(process.exitCode).toBe(1);
    }
    expect(mocks.urls).toEqual([`${ISSUER}/api/me/apps`, `${ISSUER}/api/me/apps/app1/confirm`]);
  });

  it("has no connectors check any more; the checklist moved to the Git app", () => {
    expect(connectorsCommand.subCommands).toBeUndefined();
    expect(Object.keys(appCommand.subCommands ?? {})).toContain("checklist");
  });
});
