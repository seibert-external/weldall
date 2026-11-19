import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./fixtures/git-app.js";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));

/** Runs `src/index.ts` with exactly this environment (plus PATH) until it exits or is stopped. */
function runEntryPoint(env: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: appDirectory,
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    // A start that does not fail must not hang the test.
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

function expectCleanFailure(
  result: { code: number | null; stderr: string; stdout: string },
  env: Record<string, string | undefined>,
) {
  expect(result.code).toBe(1);
  // The SDK may warn first (in-memory replay store); the failure is the configuration error.
  expect(result.stderr).toMatch(/(^|\n)Invalid Git app configuration/);
  expect(result.stderr).not.toMatch(/\n\s+at /); // no stack trace
  expect(result.stdout).not.toContain("Git app listening");
  for (const name of [
    "GIT_APP_HOST_SECRET",
    "GIT_APP_SIGNING_PRIVATE_JWK",
    "WELDALL_MACHINE_PRIVATE_JWK",
    "GIT_APP_GIT_CREDENTIAL_KEY",
  ])
    expect(result.stderr).not.toContain(env[name]);
}

describe("start-up", () => {
  let blocker: Server | undefined;
  afterEach(async () => {
    vi.doUnmock("../src/app.js");
    vi.resetModules();
    await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
    blocker = undefined;
  });

  it.each([
    ["GIT_APP_PUBLIC_ORIGIN", "http://localhost:3002"],
    ["WELDALL_ISSUER", "http://127.0.0.1:3000"],
  ])(
    "ends an http loopback %s with the configuration error and exit code 1",
    async (name, value) => {
      const env = await testEnvironment({ [name]: value });
      const result = await runEntryPoint(env);
      expectCleanFailure(result, env);
      expect(result.stderr).toContain(`${name} must use https.`);
    },
    30_000,
  );

  it("ends a port that cannot be listened on with the configuration error and exit code 1", async () => {
    blocker = createServer();
    await new Promise<void>((resolve) => blocker!.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;
    const env = await testEnvironment({ PORT: String(port) });
    const result = await runEntryPoint(env);
    expectCleanFailure(result, env);
    expect(result.stderr).toContain("PORT cannot be listened on");
  }, 30_000);

  it("turns an error while building the app into the fixed configuration error", async () => {
    vi.doMock("../src/app.js", () => ({
      createGitApp: () => {
        throw new TypeError("secret-looking detail from a dependency");
      },
    }));
    const { prepareGitApp, startupErrorMessage } = await import("../src/start.js");
    const error = await prepareGitApp(await testEnvironment()).catch((caught: unknown) => caught);
    // A fresh module graph after the mock: compare by name, not by class identity.
    expect((error as Error).name).toBe("GitAppConfigError");
    expect(startupErrorMessage(error)).toBe(
      "Invalid Git app configuration:\n- The Git app could not start with this configuration.",
    );
    expect(startupErrorMessage(new Error("detail"))).toBe("Invalid Git app configuration.");
  });

  it("builds the app from a valid configuration", async () => {
    const { prepareGitApp } = await import("../src/start.js");
    const { config, app } = await prepareGitApp(await testEnvironment());
    expect(config.publicOrigin).toBe("https://git-app.example.com");
    expect((await app.request("/health")).status).toBe(200);
  });
});
