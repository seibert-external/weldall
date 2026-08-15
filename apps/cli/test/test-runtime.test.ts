import { afterEach, describe, expect, it, vi } from "vitest";
import { runTestRuntimeHook } from "../src/test-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("test-only runtime hook", () => {
  it("does nothing when no hook is requested", async () => {
    await expect(runTestRuntimeHook({ NODE_ENV: "production" })).resolves.toBe(false);
  });

  it("rejects diagnostics and keyring hooks outside tests", async () => {
    await expect(
      runTestRuntimeHook({
        NODE_ENV: "production",
        WELDALL_TEST_RUNTIME_DIAGNOSTICS: "1",
      }),
    ).rejects.toThrow(/only allowed when NODE_ENV=test/);
    await expect(
      runTestRuntimeHook({ NODE_ENV: "production", WELDALL_TEST_KEYRING_SMOKE: "unique123" }),
    ).rejects.toThrow(/only allowed when NODE_ENV=test/);
  });

  it("reports runtime diagnostics without secrets", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(
      runTestRuntimeHook({ NODE_ENV: "test", WELDALL_TEST_RUNTIME_DIAGNOSTICS: "1" }),
    ).resolves.toBe(true);
    const diagnostics = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(diagnostics.runtime.name).toBe("node");
    expect(diagnostics.execArgv).toEqual(process.execArgv);
    expect(diagnostics.autoloadSentinels).toEqual({ dotenv: false, bunfig: false });
    expect(diagnostics).not.toHaveProperty("secret");
  });

  it("round-trips and always deletes an injected secure-store entry without exposing its secret", async () => {
    const calls: string[] = [];
    let stored: string | null = null;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    class Entry {
      setPassword(secret: string) {
        calls.push("set");
        stored = secret;
      }
      getPassword() {
        calls.push("get");
        return stored;
      }
      deletePassword() {
        calls.push("delete");
        stored = null;
      }
    }

    await expect(
      runTestRuntimeHook(
        { NODE_ENV: "test", WELDALL_TEST_KEYRING_SMOKE: "injected-success" },
        { loadKeyring: async () => ({ Entry }) },
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual(["set", "get", "delete"]);
    expect(stored).toBeNull();
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ keyringRoundTrip: true });
    expect(String(write.mock.calls[0]?.[0])).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it("round-trips through the async production keyring binding when available", async () => {
    let stored: string | null = null;
    class Entry {
      setPassword(secret: string) {
        stored = secret;
      }
      getPassword() {
        return stored;
      }
      deletePassword() {
        stored = null;
      }
    }
    class AsyncEntry {
      setPassword(secret: string) {
        stored = secret;
      }
      getPassword() {
        return Promise.resolve(stored);
      }
      deletePassword() {
        stored = null;
      }
    }

    await expect(
      runTestRuntimeHook(
        { NODE_ENV: "test", WELDALL_TEST_KEYRING_SMOKE: "production-binding" },
        { loadKeyring: async () => ({ Entry, AsyncEntry }) },
      ),
    ).resolves.toBe(true);
    expect(stored).toBeNull();
  });

  it("uses fresh secure-store entries for writes, reads, and cleanup", async () => {
    let stored: string | null = null;
    let constructions = 0;
    class Entry {
      private readonly snapshot = stored;
      constructor() {
        constructions += 1;
      }
      setPassword(secret: string) {
        stored = secret;
      }
      getPassword() {
        return this.snapshot;
      }
      deletePassword() {
        stored = null;
      }
    }

    await expect(
      runTestRuntimeHook(
        { NODE_ENV: "test", WELDALL_TEST_KEYRING_SMOKE: "fresh-entries" },
        { loadKeyring: async () => ({ Entry }) },
      ),
    ).resolves.toBe(true);
    expect(constructions).toBe(3);
    expect(stored).toBeNull();
  });

  it("allows a bounded secure-store propagation delay before validating the round trip", async () => {
    let stored: string | null = null;
    let reads = 0;
    const wait = vi.fn(async () => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    class Entry {
      setPassword(secret: string) {
        stored = secret;
      }
      getPassword() {
        reads += 1;
        return reads < 150 ? null : stored;
      }
      deletePassword() {
        stored = null;
      }
    }

    await expect(
      runTestRuntimeHook(
        { NODE_ENV: "test", WELDALL_TEST_KEYRING_SMOKE: "injected-delayed" },
        { loadKeyring: async () => ({ Entry }), wait },
      ),
    ).resolves.toBe(true);
    expect(reads).toBe(150);
    expect(wait).toHaveBeenCalledTimes(149);
    expect(stored).toBeNull();
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ keyringRoundTrip: true });
  });

  it("reads a Bun native credential by service when an exact entry lookup stays stale", async () => {
    vi.stubGlobal("Bun", { version: "1.3.14" });
    let stored: string | null = null;
    class Entry {
      setPassword(secret: string) {
        stored = secret;
      }
      getPassword() {
        return null;
      }
      deletePassword() {
        stored = null;
      }
    }

    await expect(
      runTestRuntimeHook(
        { NODE_ENV: "test", WELDALL_TEST_KEYRING_SMOKE: "service-fallback" },
        {
          loadKeyring: async () => ({
            Entry,
            findCredentialsAsync: async () => [
              { account: "unrelated", password: "wrong" },
              { account: "account-service-fallback", password: stored ?? "" },
            ],
          }),
          wait: async () => {},
        },
      ),
    ).resolves.toBe(true);
    expect(stored).toBeNull();
  });

  it("deletes after a primary secure-store failure", async () => {
    const primary = new Error("injected primary failure");
    const deletion = vi.fn();
    class Entry {
      setPassword() {
        throw primary;
      }
      getPassword() {
        return null;
      }
      deletePassword() {
        deletion();
      }
    }

    await expect(
      runTestRuntimeHook(
        { NODE_ENV: "test", WELDALL_TEST_KEYRING_SMOKE: "injected-primary" },
        { loadKeyring: async () => ({ Entry }) },
      ),
    ).rejects.toBe(primary);
    expect(deletion).toHaveBeenCalledOnce();
  });

  it("surfaces a cleanup failure after a successful secure-store round trip", async () => {
    const cleanup = new Error("injected cleanup failure");
    let stored = "";
    class Entry {
      setPassword(secret: string) {
        stored = secret;
      }
      getPassword() {
        return stored;
      }
      deletePassword() {
        throw cleanup;
      }
    }

    await expect(
      runTestRuntimeHook(
        { NODE_ENV: "test", WELDALL_TEST_KEYRING_SMOKE: "injected-cleanup" },
        { loadKeyring: async () => ({ Entry }) },
      ),
    ).rejects.toBe(cleanup);
  });

  it("aggregates primary and cleanup secure-store failures", async () => {
    const primary = new Error("injected primary failure");
    const cleanup = new Error("injected cleanup failure");
    class Entry {
      setPassword() {
        throw primary;
      }
      getPassword() {
        return null;
      }
      deletePassword() {
        throw cleanup;
      }
    }

    const failure = await runTestRuntimeHook(
      { NODE_ENV: "test", WELDALL_TEST_KEYRING_SMOKE: "injected-aggregate" },
      { loadKeyring: async () => ({ Entry }) },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
  });

  it("invokes keychain.get only through its guarded test hook", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const keychainGet = vi.fn(async () => null);
    await expect(
      runTestRuntimeHook(
        { NODE_ENV: "test", WELDALL_TEST_KEYCHAIN_GET: "https://weldall.example.com" },
        { keychainGet },
      ),
    ).resolves.toBe(true);
    expect(keychainGet).toHaveBeenCalledWith("https://weldall.example.com");
  });
});
