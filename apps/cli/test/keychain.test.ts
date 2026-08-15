import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const issuer = "https://weldall.example.com";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
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
