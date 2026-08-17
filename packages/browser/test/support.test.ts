import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectWeldallBrowserSupport,
  requireWeldallBrowserSupport,
  WeldallBrowserUnsupportedError,
} from "../src/index.js";
import { inspectWeldallBrowserSupportForTesting } from "../src/support.js";
import type { WeldallBrowserCapabilityCode } from "../src/types.js";

const originals = new Map<PropertyKey, PropertyDescriptor | undefined>();
function replace(name: PropertyKey, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  replace("crypto", webcrypto);
  replace("isSecureContext", true);
  replace("navigator", {
    onLine: true,
    locks: {
      request: async (_name: string, _options: unknown, callback: () => unknown) => callback(),
    },
  });
});

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

function cryptoWith(
  overrides: Partial<Record<keyof SubtleCrypto, unknown>> & {
    subtle?: SubtleCrypto | undefined;
    getRandomValues?: undefined;
    randomUUID?: undefined;
  },
): Crypto {
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof SubtleCrypto];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(webcrypto, {
    get(target, property) {
      if (property === "subtle") return "subtle" in overrides ? overrides.subtle : subtle;
      if (property in overrides) return overrides[property as keyof typeof overrides];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Crypto;
}

async function expectMissing(
  code: WeldallBrowserCapabilityCode,
  overrides: Parameters<typeof inspectWeldallBrowserSupportForTesting>[0],
) {
  const support = await inspectWeldallBrowserSupportForTesting(overrides);
  expect(support.supported).toBe(false);
  expect(support.missingFeatures).toContain(code);
}

describe("browser capability contract", () => {
  it("reports stable diagnostics for every public capability code", async () => {
    await expectMissing("secure-context", { secureContext: false });
    await expectMissing("crypto-subtle", { crypto: cryptoWith({ subtle: undefined }) });
    await expectMissing("p256-key-generation", {
      crypto: cryptoWith({
        generateKey: async () => {
          throw new Error("unsupported");
        },
      }),
    });
    const realPair = (await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const exportableView = new Proxy(realPair.privateKey, {
      get(target, property) {
        if (property === "extractable") return true;
        return Reflect.get(target, property, target) as unknown;
      },
    });
    await expectMissing("non-exportable-private-key", {
      crypto: cryptoWith({
        generateKey: async () => ({ ...realPair, privateKey: exportableView }),
      }),
    });
    await expectMissing("public-jwk-export", {
      crypto: cryptoWith({
        exportKey: async () => {
          throw new Error("unsupported");
        },
      }),
    });
    await expectMissing("p256-signing", {
      crypto: cryptoWith({
        sign: async () => {
          throw new Error("unsupported");
        },
      }),
    });
    await expectMissing("indexeddb", { indexedDB: undefined });
    await expectMissing("indexeddb-cryptokey-clone", {
      indexedDB: {
        open: () => {
          throw new Error("clone disabled");
        },
      } as unknown as IDBFactory,
    });
    await expectMissing("fetch", { fetch: undefined });
    await expectMissing("url", { URL: undefined });
    await expectMissing("text-encoder", { TextEncoder: undefined });
    await expectMissing("abort-controller", { AbortController: undefined });
    await expectMissing("crypto-random", {
      crypto: cryptoWith({ getRandomValues: undefined, randomUUID: undefined }),
    });
    await expectMissing("navigator-locks", { navigatorLocks: undefined });
  });

  it("throws a typed visible guard failure before application discovery", async () => {
    replace("isSecureContext", false);
    const support = await inspectWeldallBrowserSupport();
    expect(support.supported).toBe(false);
    expect(support.missingFeatures).toContain("secure-context");
    await expect(requireWeldallBrowserSupport()).rejects.toMatchObject({
      name: "WeldallBrowserUnsupportedError",
      code: "unsupported-browser",
      missingFeatures: expect.arrayContaining(["secure-context"]),
      recovery: expect.any(String),
    });
  });

  it("uses the typed unsupported error class", () => {
    expect(new WeldallBrowserUnsupportedError(["secure-context"])).toBeInstanceOf(Error);
  });
});
