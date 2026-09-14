import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const issuer = "https://weldall.example.com";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

type KeyringBehavior = {
  getPassword?: () => Promise<string | null>;
  setPassword?: (password: string) => Promise<void>;
  deletePassword?: () => Promise<boolean>;
  findCredentials?: () => Promise<Array<{ account: string; password: string }>>;
};

const withPlatform = (platform: NodeJS.Platform) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => Object.defineProperty(process, "platform", original);
};

// Loads the production keychain module against a fake keyring addon and a recording
// `execFile`, so the macOS behaviour is testable on every CI platform. `order` records the
// interleaving of the security-tool delete and the addon write to assert delete-before-set.
const loadNativeStore = async (behavior: KeyringBehavior, securityExitCode?: number) => {
  vi.stubEnv("NODE_ENV", "production");
  const order: Array<"delete" | "set"> = [];
  const setImpl = behavior.setPassword ?? (async () => {});
  const setPassword = vi.fn(async (password: string) => {
    order.push("set");
    return setImpl(password);
  });
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      order.push("delete");
      if (securityExitCode === undefined || securityExitCode === 0)
        callback(null, { stdout: "", stderr: "" });
      else
        callback(
          Object.assign(new Error(`security exited ${securityExitCode}`), {
            code: securityExitCode,
          }),
        );
    },
  );
  const deletePassword = vi.fn(behavior.deletePassword ?? (async () => true));
  vi.doMock("node:child_process", () => ({ execFile }));
  vi.doMock("@napi-rs/keyring", () => ({
    AsyncEntry: class {
      getPassword = behavior.getPassword ?? (async () => null);
      setPassword = setPassword;
      deletePassword = deletePassword;
    },
    findCredentialsAsync: behavior.findCredentials ?? (async () => []),
  }));
  const { nativeCredentialStore } = await import("../src/storage/keychain.js");
  return { nativeCredentialStore, setPassword, deletePassword, execFile, order };
};

// Asserts the one and only `execFile` call was a prompt-free security-tool delete of exactly
// this item.
const expectSecurityDelete = (
  execFile: ReturnType<typeof vi.fn>,
  service: string,
  account: string,
) => {
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(execFile.mock.calls[0]?.[0]).toBe("/usr/bin/security");
  expect(execFile.mock.calls[0]?.[1]).toEqual([
    "delete-generic-password",
    "-s",
    service,
    "-a",
    account,
  ]);
};

describe("native credential store", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("@napi-rs/keyring");
  });

  it("falls back to enumerating the service under Bun when the exact lookup returns null", async () => {
    vi.stubGlobal("Bun", { version: "test" });
    try {
      const { nativeCredentialStore } = await loadNativeStore({
        getPassword: async () => null,
        findCredentials: async () => [
          { account: "other", password: "wrong" },
          { account: "acct", password: "found-by-enumeration" },
        ],
      });
      await expect(nativeCredentialStore.get("svc", "acct")).resolves.toBe("found-by-enumeration");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a miss under Node a single lookup without enumerating", async () => {
    const findCredentials = vi.fn(async () => [
      { account: "acct", password: "should-not-be-read" },
    ]);
    const { nativeCredentialStore } = await loadNativeStore({
      getPassword: async () => null,
      findCredentials,
    });
    await expect(nativeCredentialStore.get("svc", "acct")).resolves.toBeNull();
    expect(findCredentials).not.toHaveBeenCalled();
  });

  it("deletes any pre-existing macOS item before writing, so the addon always inserts cleanly", async () => {
    const restore = withPlatform("darwin");
    try {
      const { nativeCredentialStore, setPassword, execFile, order } = await loadNativeStore({});
      await nativeCredentialStore.set("svc", "acct", "secret");
      expect(order).toEqual(["delete", "set"]);
      expectSecurityDelete(execFile, "svc", "acct");
      expect(setPassword).toHaveBeenCalledTimes(1);
      expect(setPassword).toHaveBeenCalledWith("secret");
    } finally {
      restore();
    }
  });

  it("treats a missing item (security exit 44) before set as normal, not an error", async () => {
    const restore = withPlatform("darwin");
    try {
      const { nativeCredentialStore, order } = await loadNativeStore({}, 44);
      await expect(nativeCredentialStore.set("svc", "acct", "secret")).resolves.toBeUndefined();
      expect(order).toEqual(["delete", "set"]);
    } finally {
      restore();
    }
  });

  it("does not write when the pre-delete fails for another reason", async () => {
    const restore = withPlatform("darwin");
    try {
      const { nativeCredentialStore, setPassword, order } = await loadNativeStore({}, 1);
      await expect(nativeCredentialStore.set("svc", "acct", "secret")).rejects.toThrow(
        "security exited 1",
      );
      expect(order).toEqual(["delete"]);
      expect(setPassword).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("surfaces an addon write failure after the pre-delete without retrying", async () => {
    const restore = withPlatform("darwin");
    try {
      const { nativeCredentialStore, setPassword, order } = await loadNativeStore({
        setPassword: async () => {
          throw Object.assign(new Error("Platform failure: keychain locked"), {
            code: "GenericFailure",
          });
        },
      });
      await expect(nativeCredentialStore.set("svc", "acct", "secret")).rejects.toThrow("locked");
      expect(order).toEqual(["delete", "set"]);
      expect(setPassword).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("never invokes the security tool for set or clear outside macOS", async () => {
    const restore = withPlatform("linux");
    try {
      const { nativeCredentialStore, execFile } = await loadNativeStore({
        deletePassword: async () => false,
      });
      await nativeCredentialStore.set("svc", "acct", "secret");
      await nativeCredentialStore.clear("svc", "acct");
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("clears on macOS through the security tool without touching the addon", async () => {
    const restore = withPlatform("darwin");
    try {
      const { nativeCredentialStore, execFile, deletePassword } = await loadNativeStore({});
      await nativeCredentialStore.clear("svc", "acct");
      expect(deletePassword).not.toHaveBeenCalled();
      expectSecurityDelete(execFile, "svc", "acct");
    } finally {
      restore();
    }
  });

  it("treats a missing item (security exit 44) as a successful clear", async () => {
    const restore = withPlatform("darwin");
    try {
      const { nativeCredentialStore } = await loadNativeStore({}, 44);
      await expect(nativeCredentialStore.clear("svc", "acct")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  it("propagates other security tool failures from clear", async () => {
    const restore = withPlatform("darwin");
    try {
      const { nativeCredentialStore } = await loadNativeStore({}, 1);
      await expect(nativeCredentialStore.clear("svc", "acct")).rejects.toThrow("security exited 1");
    } finally {
      restore();
    }
  });

  it("clears through the addon outside macOS, without the security tool", async () => {
    const restore = withPlatform("linux");
    try {
      const { nativeCredentialStore, deletePassword, execFile } = await loadNativeStore({});
      await nativeCredentialStore.clear("svc", "acct");
      expect(deletePassword).toHaveBeenCalledTimes(1);
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("E2E credential store", () => {
  it("is rejected outside the test environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WELDALL_E2E_CREDENTIALS_FILE", "/tmp/forbidden-weldall-credentials");
    await expect(import("../src/storage/keychain.js")).rejects.toThrow(
      "only allowed when NODE_ENV=test",
    );
  });

  it("fails closed with an actionable platform-neutral error when the native store is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.doMock("@napi-rs/keyring", () => {
      throw new Error("native binding unavailable");
    });
    try {
      const { keychain } = await import("../src/storage/keychain.js");

      await expect(keychain.get(issuer)).rejects.toMatchObject({
        message: expect.stringContaining("secure credential store"),
        hint: expect.stringContaining("@napi-rs/keyring"),
      });
    } finally {
      vi.doUnmock("@napi-rs/keyring");
    }
  });

  it("reads legacy v1 credentials without requiring login again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall legacy keychain "));
    const path = join(directory, "credentials.json");
    try {
      const account = `session-${createHash("sha256").update(issuer).digest("base64url")}`;
      await writeFile(
        path,
        JSON.stringify({
          [account]: {
            version: 1,
            issuer,
            privateJwk: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" },
            publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
            refreshToken: "legacy-refresh-token",
          },
        }),
        { mode: 0o600 },
      );
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("WELDALL_E2E_CREDENTIALS_FILE", path);
      const { keychain } = await import("../src/storage/keychain.js");

      await expect(keychain.get(issuer)).resolves.toMatchObject({
        version: 1,
        issuer,
        refreshToken: "legacy-refresh-token",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("isolates issuer sessions and persists them with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall keychain ünicode "));
    const path = join(directory, "credentials.json");
    try {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("WELDALL_E2E_CREDENTIALS_FILE", path);
      const { keychain } = await import("../src/storage/keychain.js");
      const credentials = {
        privateJwk: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" },
        publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        refreshToken: "test-refresh-token",
        identity: { name: "Test User", email: "test@example.com" },
      };

      await keychain.set(issuer, credentials);
      await expect(keychain.get(issuer)).resolves.toMatchObject({ issuer, ...credentials });

      const legacyIssuer = "https://legacy.example.com";
      await keychain.set(legacyIssuer, {
        privateJwk: credentials.privateJwk,
        publicJwk: credentials.publicJwk,
        refreshToken: credentials.refreshToken,
      });
      await expect(keychain.get(legacyIssuer)).resolves.toMatchObject({
        issuer: legacyIssuer,
        refreshToken: credentials.refreshToken,
      });
      expect((await keychain.get(legacyIssuer))?.identity).toBeUndefined();
      await expect(keychain.get("https://other.example.com")).resolves.toBeNull();
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(Object.values(JSON.parse(await readFile(path, "utf8")) as object)).toHaveLength(2);

      await keychain.clear(issuer);
      await keychain.clear(legacyIssuer);
      await expect(keychain.get(issuer)).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
