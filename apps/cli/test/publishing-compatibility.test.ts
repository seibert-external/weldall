import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "gunshi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair, type ResourceRegistryEntry } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";

/**
 * Cross-version: this CLI against Weldall servers without publishing: the shipped server, whose
 * `GET /api/me/apps` answers without `registries` or does not exist (404), and a newer one that
 * lists no registry. Whatever resources are registered (none, other resources only, or a registry
 * whose own metadata announces an apps API), only Weldall's `registries` make a resource a
 * registry, so every app command reads Weldall's two lists and nothing else. Each command must say
 * clearly that publishing is not set up, with a stable code and exit code, ask no token for
 * anything, read no resource's metadata, and change nothing locally. The real direct code runs;
 * only the login and `fetch` are stand-ins.
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
  /** The `GET /api/me/apps` answer; null answers 404. */
  apps: null as unknown,
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
import { mainCommand } from "../src/commands.js";
import { appCommand } from "../src/app-commands.js";

const AGENTS = "https://agents.example.com";
/** A registry whose own metadata announces an apps API, which the CLI must not believe. */
const agentsOnly: ResourceRegistryEntry = {
  key: "registry",
  name: "Registry",
  resourceIdentifier: `${AGENTS}/api`,
  authorizationServer: AGENTS,
  downstreamClientId: "weldall-cli-at-registry",
  requestPrefixes: [`${AGENTS}/api`],
  supportedScopes: ["registry:agents"],
  grantedScopes: ["registry:agents"],
};
const announcingMetadata = {
  resource: `${AGENTS}/api`,
  authorization_servers: [AGENTS],
  scopes_supported: ["registry:agents"],
  weldall_apps_api: {
    endpoint: `${AGENTS}/api/apps`,
    scope: "registry:agents",
    git: `${AGENTS}/git/`,
    gitCredentials: `${AGENTS}/api/git-credentials`,
  },
};
const APPS = `${ISSUER}/api/me/apps`;
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
      subCommands: { app: appCommand },
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
      if (url === APPS && mocks.apps !== null) return Response.json(mocks.apps);
      if (url === `${AGENTS}/.well-known/oauth-protected-resource`)
        return Response.json(announcingMetadata);
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

/** Each command reads Weldall's two lists, in either order, and nothing else. */
const discovery = [APPS, config.scopes].sort();
const opened = (count: number) => {
  expect(mocks.urls).toHaveLength(2 * count);
  for (let index = 0; index < count; index += 1)
    expect(mocks.urls.slice(2 * index, 2 * index + 2).sort()).toEqual(discovery);
};

describe.each([
  ["no resource registered", [] as ResourceRegistryEntry[]],
  ["other resources only", [expenses]],
  ["a resource whose own metadata announces an apps API", [expenses, agentsOnly]],
])("this CLI with %s", (_resources, registry) => {
  describe.each([
    ["a shipped server without the app list (404)", null],
    ["a shipped server whose app list has no registries", { items: [], warnings: [] }],
    ["a server that lists no registry", { items: [], warnings: [], registries: [] }],
  ])("against %s", (_server, apps) => {
    beforeEach(() => {
      mocks.registry = registry;
      mocks.apps = apps;
    });

    it("app publish fails with publishing_not_set_up, asks for no token and leaves the folder as it was", async () => {
      const head = git(folder, ["rev-parse", "HEAD"]);
      const before = git(folder, ["status", "--porcelain"]);
      const result = await run([
        "app",
        "publish",
        `--dir=${folder}`,
        "--name=expenses",
        "--description=Track expenses",
        "--json",
      ]);
      expect(result).toEqual({
        outcome: "error",
        error: expect.objectContaining({
          code: "publishing_not_set_up",
          message: expect.stringContaining("Your organisation has not set up publishing apps"),
          hint: expect.stringContaining("Weldall administrator"),
        }),
      });
      expect(process.exitCode).toBe(1);
      opened(1);
      // Nothing was committed, recorded or configured: the folder can publish once one exists.
      expect(git(folder, ["rev-parse", "HEAD"])).toBe(head);
      expect(git(folder, ["status", "--porcelain"])).toBe(before);
      expect(git(folder, ["for-each-ref", "refs/weldall"])).toBe("");
      expect(git(folder, ["config", "--get-regexp", "^weldall\\."]).split("\n").sort()).toEqual(
        [`weldall.template react`, `weldall.templatecommit ${head}`].sort(),
      );
      expect(git(folder, ["remote"])).toBe("");
    });

    it("app checklist and app list --all fail with publishing_not_set_up", async () => {
      for (const argv of [
        ["app", "checklist", "--json"],
        ["app", "list", "--all", "--json"],
        ["app", "set-owner", "app_1", "--owner=user-2", "--json"],
      ]) {
        process.exitCode = undefined;
        expect(await run(argv)).toMatchObject({
          outcome: "error",
          error: {
            code: "publishing_not_set_up",
            message: expect.stringContaining("administering apps"),
          },
        });
        expect(process.exitCode).toBe(1);
      }
      opened(3);
    });

    it("app list, app confirm and app status of an app id fail with publishing_not_set_up", async () => {
      for (const argv of [
        ["app", "list", "--json"],
        ["app", "confirm", "app_1", "--json"],
        ["app", "status", "--app=app_1", "--json"],
      ]) {
        process.exitCode = undefined;
        expect(await run(argv)).toMatchObject({
          outcome: "error",
          error: {
            code: "publishing_not_set_up",
            hint: expect.stringContaining("Weldall administrator"),
          },
        });
        expect(process.exitCode).toBe(1);
      }
      opened(3);
    });

    it("app publish with --registry names what Weldall lists instead", async () => {
      const result = await run([
        "app",
        "publish",
        `--dir=${folder}`,
        "--registry=registry",
        "--name=expenses",
        "--description=Track expenses",
        "--json",
      ]);
      expect(result).toMatchObject({ outcome: "error", error: { code: "registry_unknown" } });
    });
  });
});
