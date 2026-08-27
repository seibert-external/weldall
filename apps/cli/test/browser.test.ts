import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Agent, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WeldallConfig } from "../src/config.js";
import { loopback } from "../src/oauth/loopback.js";
import { login } from "../src/services/auth.js";
import {
  browserOpenTimeoutMs,
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

afterEach(() => vi.restoreAllMocks());

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

  it("closes the accepted loopback connection after returning the authorization result", async () => {
    const callback = await loopback("expected-state", config.issuer, 5_000);
    const callbackUrl = new URL(callback.redirectUri);
    callbackUrl.searchParams.set("state", "expected-state");
    callbackUrl.searchParams.set("iss", config.issuer);
    callbackUrl.searchParams.set("code", "authorization-code");
    const agent = new Agent({ keepAlive: true });

    try {
      const connection = await new Promise<string | undefined>((resolve, reject) => {
        const request = get(callbackUrl, { agent }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.headers.connection));
        });
        request.once("error", reject);
      });

      expect(connection).toBe("close");
      await expect(callback.code).resolves.toBe("authorization-code");
      await expect(fetch(callback.redirectUri)).rejects.toThrow();
    } finally {
      callback.close();
      agent.destroy();
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
