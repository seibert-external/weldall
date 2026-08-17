import {
  calculateJkt,
  createBrowserDpopProof,
  createWeldallBrowserClient,
  inspectWeldallBrowserSupport,
} from "@weldall/browser";

declare global {
  interface Window {
    weldallProbe: () => Promise<Record<string, unknown>>;
    weldallConnectionProbe: () => Promise<Record<string, unknown>>;
    weldallSharedConnect: (databaseName: string) => Promise<Record<string, unknown>>;
    weldallSharedRemote: (databaseName: string) => Promise<Record<string, unknown>>;
    weldallCancelPending: (databaseName: string) => Promise<Record<string, unknown>>;
  }
}

window.weldallProbe = async () => {
  const support = await inspectWeldallBrowserSupport();
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jkt = await calculateJkt(publicJwk);
  const proof = await createBrowserDpopProof({
    privateKey: pair.privateKey,
    publicJwk,
    method: "POST",
    url: "https://resource.example/oauth/token",
  });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("weldall-fixture", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const write = database.transaction("keys", "readwrite");
  write.objectStore("keys").put(pair.privateKey, "private");
  await new Promise<void>((resolve, reject) => {
    write.oncomplete = () => resolve();
    write.onerror = () => reject(write.error);
  });
  const read = database.transaction("keys").objectStore("keys").get("private");
  const reloaded = await new Promise<CryptoKey>((resolve, reject) => {
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  database.close();
  return {
    support,
    privateExtractable: pair.privateKey.extractable,
    reloadedExtractable: reloaded.extractable,
    reloadedSignatureBytes: (
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, reloaded, new Uint8Array([9]))
    ).byteLength,
    jkt,
    proofParts: proof.split(".").length,
  };
};

const sharedClient = (databaseName: string) =>
  createWeldallBrowserClient({
    issuer: "https://weldall.example",
    resource: "https://resource.example/api",
    origin: "https://resource.example",
    databaseName,
  } as never);

window.weldallSharedConnect = async (databaseName) => {
  const client = await sharedClient(databaseName);
  const pending = await client.connect();
  return pending.connected;
};

window.weldallSharedRemote = async (databaseName) => {
  const client = await sharedClient(databaseName);
  return client.getConnectionStatus({ verify: "remote" });
};

window.weldallCancelPending = async (databaseName) => {
  const client = await sharedClient(databaseName);
  const pending = await client.connect();
  const started = performance.now();
  await client.clearLocalConnection();
  let rejection = "";
  try {
    await pending.connected;
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
  }
  return {
    elapsedMs: performance.now() - started,
    rejection,
    status: await client.getConnectionStatus({ verify: "local" }),
  };
};

window.weldallConnectionProbe = async () => {
  const client = await createWeldallBrowserClient({
    issuer: "https://weldall.example",
    resource: "https://resource.example/api",
    origin: "https://resource.example",
    databaseName: `weldall-browser-fixture-${crypto.randomUUID()}`,
  });
  const before = await client.getConnectionStatus({ verify: "local" });
  const pending = await client.connect();
  const connected = await pending.connected;
  const local = await client.getConnectionStatus({ verify: "local" });
  const remote = await client.getConnectionStatus({ verify: "remote" });
  const resourceResponse = await client.request("https://resource.example/api/data", {
    scopes: ["resource:read"],
  });
  const resourceBody = await resourceResponse.json();
  let disconnectFailure: string | undefined;
  try {
    await client.disconnect();
  } catch (error) {
    disconnectFailure = error instanceof Error ? error.message : String(error);
  }
  const afterFailedDisconnect = await client.getConnectionStatus({ verify: "local" });
  await client.disconnect();
  const after = await client.getConnectionStatus({ verify: "local" });
  await client.clearLocalConnection();
  return {
    before,
    userCode: pending.userCode,
    connected,
    local,
    remote,
    resourceStatus: resourceResponse.status,
    resourceBody,
    disconnectFailure,
    afterFailedDisconnect,
    after,
  };
};

document.querySelector("#result")!.textContent = "ready";
