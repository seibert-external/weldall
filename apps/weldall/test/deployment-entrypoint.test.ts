import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entrypoint = readFileSync(new URL("../../../entrypoint.sh", import.meta.url), "utf8");
const prismaExecutable = "/app/packages/db/node_modules/.bin/prisma";
const requiredVariables = [
  "POSTGRES_URL",
  "WELDALL_ISSUER",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "WELDALL_SIGNING_PRIVATE_JWK",
  "WELDALL_SIGNING_PUBLIC_JWK",
  "WELDALL_SIGNING_KID",
];

// Exercise the production shell script with child executables standing in for
// database migration, initialization, and the server. No database is contacted.
describe.skipIf(process.platform === "win32")("production entrypoint", () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "weldall-entrypoint-"));
    writeFileSync(
      join(directory, "prisma"),
      '#!/bin/sh\nprintf "prisma:%s\\n" "${WELDALL_DEPLOYMENT_MODE-unset}"\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(directory, "node"),
      '#!/bin/sh\nprintf "node:%s:%s\\n" "${WELDALL_DEPLOYMENT_MODE-unset}" "$1"\n',
      { mode: 0o700 },
    );
  });

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const run = (overrides: NodeJS.ProcessEnv = {}) => {
    expect(entrypoint).toContain(prismaExecutable);
    return spawnSync("/bin/sh", ["-c", entrypoint.replace(prismaExecutable, "prisma")], {
      encoding: "utf8",
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        ...Object.fromEntries(requiredVariables.map((name) => [name, "test-only"])),
        ...overrides,
      },
    });
  };

  it.each([undefined, "", "production"])("exports production when mode is %s", (mode) => {
    const result = run({ WELDALL_DEPLOYMENT_MODE: mode });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "prisma:production",
      "node:production:/app/packages/db/deployment-init.mjs",
      "node:production:apps/weldall/server.js",
    ]);
  });

  it.each(["development", "e2e", "invalid"])("rejects %s before running commands", (mode) => {
    const result = run({ WELDALL_DEPLOYMENT_MODE: mode });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WELDALL_DEPLOYMENT_MODE must be production");
    expect(result.stdout).toBe("");
  });

  it.each(requiredVariables)("rejects a missing %s before running commands", (name) => {
    const result = run({ [name]: undefined });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${name} is required`);
    expect(result.stdout).toBe("");
  });
});
