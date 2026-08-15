import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WeldallConfig } from "../src/config.js";
import { login } from "../src/services/auth.js";
import {
  browserOpenTimeoutMs,
  browserOpener,
  createBrowserOpener,
  runBrowserCommand,
} from "../src/services/browser.js";

const authorizationUrl =
  "https://weldall.example.com/authorize?value=a&next=$(touch /tmp/pwned);echo";

const config: WeldallConfig = {
  issuer: "https://weldall.example.com",
  resource: "https://weldall.example.com/api",
  authorize: "https://weldall.example.com/authorize",
  token: "https://weldall.example.com/token",
  revoke: "https://weldall.example.com/revoke",
  jwks: "https://weldall.example.com/jwks",
  cli: "https://weldall.example.com/api/me/cli",
  grants: "https://weldall.example.com/api/me/grants",
  scopes: "https://weldall.example.com/api/me/scopes",
  skills: "https://weldall.example.com/api/me/skills",
  userInfo: "https://weldall.example.com/userinfo",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("browser opener", () => {
  it.each([
    ["darwin", "open", [authorizationUrl]],
    ["linux", "xdg-open", [authorizationUrl]],
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", authorizationUrl]],
  ] as const)("uses the %s execFile argument shape", async (platform, executable, args) => {
    const runner = vi.fn(async () => undefined);

    await createBrowserOpener({ platform, runner })(authorizationUrl);

    expect(runner).toHaveBeenCalledWith(executable, args);
    expect(runner.mock.calls[0]?.at(-1)).toEqual(args);
  });

  it("bounds and terminates platform browser commands", async () => {
    const timeout = Object.assign(new Error("browser command timed out"), { code: "ETIMEDOUT" });
    const execute = vi.fn((_executable, _args, options, callback) => {
      expect(options).toEqual({
        timeout: browserOpenTimeoutMs,
        killSignal: "SIGTERM",
        windowsHide: true,
      });
      callback(timeout);
    });

    await expect(runBrowserCommand("open", [authorizationUrl], execute)).rejects.toBe(timeout);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects the E2E URL-file seam outside tests", () => {
    expect(() =>
      createBrowserOpener({ e2eUrlFile: "/tmp/browser-url", nodeEnv: "production" }),
    ).toThrow("only allowed when NODE_ENV=test");
  });

  it("atomically replaces the E2E browser URL file with safe permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall browser ünicode-"));
    const path = join(directory, "browser url.txt");
    try {
      await writeFile(path, "old");
      const opener = createBrowserOpener({ e2eUrlFile: path, nodeEnv: "test" });
      await opener(authorizationUrl);
      expect(await readFile(path, "utf8")).toBe(authorizationUrl);
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await access(path).then(() => true)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves the guarded E2E seam when the exported opener is invoked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall browser runtime ünicode-"));
    const path = join(directory, "browser url.txt");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WELDALL_E2E_BROWSER_URL_FILE", path);
    try {
      await browserOpener(authorizationUrl);
      expect(await readFile(path, "utf8")).toBe(authorizationUrl);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("handles an early loopback rejection while a failing browser opener is still pending", async () => {
    const opener = vi.fn(async (url: string) => {
      const authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
      callback.searchParams.set("iss", config.issuer);
      callback.searchParams.set("error", "access_denied");
      await fetch(callback);
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("opener timed out");
    });
    const withoutUserLock = async <T>(operation: () => Promise<T>) => operation();

    await expect(login(config, opener, withoutUserLock)).rejects.toMatchObject({
      message: "Unable to open the Weldall login page in your browser",
    });
    expect(opener).toHaveBeenCalledOnce();
  });

  it("lets login inject an opener and closes the loopback listener when opening fails", async () => {
    let redirectUri = "";
    const opener = vi.fn(async (url: string) => {
      redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      throw new Error("opener missing");
    });

    let lockInvocations = 0;
    const withoutUserLock = async <T>(operation: () => Promise<T>) => {
      lockInvocations += 1;
      return operation();
    };

    await expect(login(config, opener, withoutUserLock)).rejects.toMatchObject({
      message: "Unable to open the Weldall login page in your browser",
      hint: expect.stringContaining("default browser"),
    });
    expect(lockInvocations).toBe(1);
    expect(opener).toHaveBeenCalledOnce();
    await expect(fetch(redirectUri)).rejects.toThrow();
  });
});
