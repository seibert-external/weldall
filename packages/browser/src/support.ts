import { WeldallBrowserUnsupportedError } from "./errors.js";
import {
  WELDALL_BROWSER_CAPABILITY_CODES,
  type WeldallBrowserCapabilityCode,
  type WeldallBrowserSupport,
} from "./types.js";

const PROBE_DB = "weldall-browser-capability-probe";

type BrowserSupportEnvironment = {
  secureContext: boolean;
  crypto?: Crypto;
  indexedDB?: IDBFactory;
  fetch?: typeof globalThis.fetch;
  URL?: typeof globalThis.URL;
  TextEncoder?: typeof globalThis.TextEncoder;
  AbortController?: typeof globalThis.AbortController;
  navigatorLocks?: LockManager;
};

function currentEnvironment(): BrowserSupportEnvironment {
  return {
    secureContext: globalThis.isSecureContext === true,
    ...(globalThis.crypto ? { crypto: globalThis.crypto } : {}),
    ...(typeof globalThis.indexedDB === "object" ? { indexedDB: globalThis.indexedDB } : {}),
    ...(typeof globalThis.fetch === "function" ? { fetch: globalThis.fetch } : {}),
    ...(typeof globalThis.URL === "function" ? { URL: globalThis.URL } : {}),
    ...(typeof globalThis.TextEncoder === "function"
      ? { TextEncoder: globalThis.TextEncoder }
      : {}),
    ...(typeof globalThis.AbortController === "function"
      ? { AbortController: globalThis.AbortController }
      : {}),
    ...("navigator" in globalThis && navigator.locks ? { navigatorLocks: navigator.locks } : {}),
  };
}

function openProbeDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(PROBE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("probe"))
        request.result.createObjectStore("probe");
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function cryptoAndStorageProbe(
  missing: Set<WeldallBrowserCapabilityCode>,
  environment: BrowserSupportEnvironment,
): Promise<void> {
  const subtle = environment.crypto?.subtle;
  if (!subtle) {
    missing.add("p256-key-generation");
    missing.add("non-exportable-private-key");
    missing.add("public-jwk-export");
    missing.add("p256-signing");
    missing.add("indexeddb-cryptokey-clone");
    return;
  }
  let pair: CryptoKeyPair;
  try {
    pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
  } catch {
    missing.add("p256-key-generation");
    missing.add("non-exportable-private-key");
    missing.add("public-jwk-export");
    missing.add("p256-signing");
    missing.add("indexeddb-cryptokey-clone");
    return;
  }
  if (pair.privateKey.extractable) missing.add("non-exportable-private-key");
  try {
    await subtle.exportKey("jwk", pair.publicKey);
  } catch {
    missing.add("public-jwk-export");
  }
  try {
    await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new Uint8Array([1, 2, 3]),
    );
  } catch {
    missing.add("p256-signing");
  }
  if (!environment.indexedDB) {
    missing.add("indexeddb-cryptokey-clone");
    return;
  }
  let database: IDBDatabase | undefined;
  try {
    database = await openProbeDatabase(environment.indexedDB);
    const write = database.transaction("probe", "readwrite");
    write.objectStore("probe").put(pair.privateKey, "key");
    await transactionDone(write);
    const read = database.transaction("probe", "readonly").objectStore("probe").get("key");
    const loaded = await new Promise<unknown>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error ?? new Error("IndexedDB read failed"));
    });
    if (
      !loaded ||
      typeof loaded !== "object" ||
      (loaded as CryptoKey).type !== "private" ||
      (loaded as CryptoKey).extractable
    )
      throw new Error("CryptoKey did not survive structured cloning");
    await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      loaded as CryptoKey,
      new Uint8Array([4, 5, 6]),
    );
  } catch {
    missing.add("indexeddb-cryptokey-clone");
  } finally {
    database?.close();
    if (typeof environment.indexedDB.deleteDatabase === "function")
      environment.indexedDB.deleteDatabase(PROBE_DB);
  }
}

async function inspectEnvironment(
  environment: BrowserSupportEnvironment,
): Promise<WeldallBrowserSupport> {
  const missing = new Set<WeldallBrowserCapabilityCode>();
  if (!environment.secureContext) missing.add("secure-context");
  if (!environment.crypto?.subtle) missing.add("crypto-subtle");
  if (!environment.indexedDB) missing.add("indexeddb");
  if (!environment.fetch) missing.add("fetch");
  if (!environment.URL) missing.add("url");
  if (!environment.TextEncoder) missing.add("text-encoder");
  if (!environment.AbortController) missing.add("abort-controller");
  if (!environment.crypto?.getRandomValues || !environment.crypto.randomUUID)
    missing.add("crypto-random");
  if (!environment.navigatorLocks) missing.add("navigator-locks");
  await cryptoAndStorageProbe(missing, environment);
  const missingFeatures = WELDALL_BROWSER_CAPABILITY_CODES.filter((code) => missing.has(code));
  const testedFeatures = WELDALL_BROWSER_CAPABILITY_CODES.filter((code) => !missing.has(code));
  return missingFeatures.length
    ? { supported: false, missingFeatures, testedFeatures }
    : { supported: true, missingFeatures: [], testedFeatures };
}

/** Internal deterministic seam used only by package tests. Not exported from the package root. */
export function inspectWeldallBrowserSupportForTesting(
  overrides: Partial<BrowserSupportEnvironment>,
): Promise<WeldallBrowserSupport> {
  return inspectEnvironment({ ...currentEnvironment(), ...overrides });
}

export function inspectWeldallBrowserSupport(): Promise<WeldallBrowserSupport> {
  return inspectEnvironment(currentEnvironment());
}

export async function requireWeldallBrowserSupport(): Promise<void> {
  const support = await inspectWeldallBrowserSupport();
  if (!support.supported) throw new WeldallBrowserUnsupportedError(support.missingFeatures);
}
