import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { BrowserConnectionStore } from "../src/storage.js";

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  if (!("CryptoKey" in globalThis))
    Object.defineProperty(globalThis, "CryptoKey", {
      configurable: true,
      value: Object.getPrototypeOf(
        // The constructor is not exposed by every Node version.
        webcrypto.subtle,
      ).constructor,
    });
});

describe("browser connection storage", () => {
  it("atomically persists, reloads and clears a non-exportable CryptoKey", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const store = new BrowserConnectionStore(`test-${crypto.randomUUID()}`);
    await store.write({
      schemaVersion: 1,
      issuer: "https://weldall.example",
      resource: "https://resource.example/api",
      origin: "https://resource.example",
      browserClientId: "weldall-browser:resource",
      privateKey: pair.privateKey,
      publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
      jkt: "a".repeat(43),
      refreshToken: "rotating-refresh",
      connectionId: "connection-1",
      subject: "subject-1",
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const loaded = (await store.read()) as { privateKey: CryptoKey; refreshToken: string };
    expect(loaded.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        loaded.privateKey,
        new Uint8Array([1]),
      ),
    ).resolves.toBeInstanceOf(ArrayBuffer);
    expect(loaded.refreshToken).toBe("rotating-refresh");
    await store.clear();
    expect(await store.read()).toBeUndefined();
  });
});
