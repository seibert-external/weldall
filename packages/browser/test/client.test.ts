import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateJkt } from "../src/dpop.js";
import { browserConnectionNamespace, WeldallBrowserClientImpl } from "../src/client.js";
import { BrowserConnectionStore } from "../src/storage.js";
import { WeldallBrowserError } from "../src/errors.js";

const issuer = "https://weldall.example";
const resource = "https://resource.example/api";
const origin = "https://resource.example";
const originals = new Map<PropertyKey, PropertyDescriptor | undefined>();

function replace(name: PropertyKey, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  replace("crypto", webcrypto);
  replace("isSecureContext", true);
  replace("location", { origin, hostname: "localhost" });
  replace("navigator", {
    onLine: true,
    locks: {
      request: async (_name: string, _options: unknown, callback: () => unknown) => callback(),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

async function keyRecord(databaseName: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    store: new BrowserConnectionStore(databaseName),
    pair,
    publicJwk,
    base: {
      schemaVersion: 1 as const,
      issuer,
      resource,
      origin,
      browserClientId: "weldall-browser:resource",
      privateKey: pair.privateKey,
      publicJwk,
      jkt: await calculateJkt(publicJwk),
    },
  };
}

function client(databaseName: string | undefined, fetcher = vi.fn(), resourceValue = resource) {
  return new WeldallBrowserClientImpl({
    issuer,
    resource: resourceValue,
    fetch: fetcher as unknown as typeof fetch,
    origin,
    ...(databaseName ? { databaseName } : {}),
  } as never);
}

const discovery = {
  issuer,
  token_endpoint: `${issuer}/api/auth/oauth2/token`,
  device_authorization_endpoint: `${issuer}/api/auth/oauth2/device_authorization`,
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  weldall_browser_connections: {
    current_status_endpoint: `${issuer}/api/me/browser-connections/current`,
    current_revoke_endpoint: `${issuer}/api/me/browser-connections/current/revoke`,
    resource_registry_endpoint: `${issuer}/api/me/scopes`,
    resource_discovery_endpoint: `${issuer}/api/browser/resources/current`,
  },
};

function accessToken(record: Awaited<ReturnType<typeof keyRecord>>["base"]) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none", typ: "at+jwt" })}.${encode({
    iss: issuer,
    sub: "subject",
    aud: `${issuer}/api`,
    client_id: record.browserClientId,
    cnf: { jkt: record.jkt },
    weldall_connection_id: "connection",
    weldall_connection_origin: origin,
    weldall_connection_resource: resource,
    exp: Math.floor(Date.now() / 1_000) + 300,
  })}.signature`;
}

async function connectedRecord(databaseName: string) {
  const keyed = await keyRecord(databaseName);
  await keyed.store.write({
    ...keyed.base,
    refreshToken: "refresh",
    connectionId: "connection",
    subject: "subject",
    refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return keyed;
}

describe("browser connection local invariants", () => {
  it("uses the same distinct namespace dimension for each issuer/resource pair", () => {
    expect(browserConnectionNamespace(issuer, resource)).not.toBe(
      browserConnectionNamespace(issuer, "https://other.example/api"),
    );
    expect(browserConnectionNamespace(issuer, resource)).toContain(resource);
  });

  it("keeps two resource connections isolated under one issuer", async () => {
    const otherResource = "https://other.example/api";
    const first = await keyRecord(browserConnectionNamespace(issuer, resource));
    const second = await keyRecord(browserConnectionNamespace(issuer, otherResource));
    const expires = new Date(Date.now() + 60_000).toISOString();
    await first.store.write({
      ...first.base,
      refreshToken: "refresh-first",
      connectionId: "connection-first",
      subject: "subject",
      refreshExpiresAt: expires,
    });
    await second.store.write({
      ...second.base,
      resource: otherResource,
      browserClientId: "weldall-browser:other",
      refreshToken: "refresh-second",
      connectionId: "connection-second",
      subject: "subject",
      refreshExpiresAt: expires,
    });
    await client(undefined).clearLocalConnection();
    const otherStatus = await client(undefined, vi.fn(), otherResource).getConnectionStatus();
    expect(otherStatus).toMatchObject({ state: "connected", connectionId: "connection-second" });
  });

  it.each([
    { refreshToken: "refresh" },
    { connectionId: "connection" },
    { subject: "subject" },
    { refreshExpiresAt: new Date(Date.now() + 60_000).toISOString() },
  ])("reports each partial credential combination as corrupt storage", async (partial) => {
    const databaseName = `partial-${crypto.randomUUID()}`;
    const { store, base } = await keyRecord(databaseName);
    await store.write({ ...base, ...partial } as never);
    await expect(client(databaseName).getConnectionStatus()).resolves.toEqual({
      state: "invalid",
      verified: "local",
      reason: "corrupt-storage",
    });
  });

  it("translates corrupt storage failures for connect, request and disconnect into typed errors", async () => {
    const databaseName = `typed-corrupt-${crypto.randomUUID()}`;
    const { store, base } = await keyRecord(databaseName);
    await store.write({ ...base, refreshToken: "partial" } as never);
    const instance = client(databaseName);
    for (const operation of [
      () => instance.connect(),
      () => instance.request(`${origin}/api/data`, { scopes: ["resource:read"] }),
      () => instance.disconnect(),
    ])
      await expect(operation()).rejects.toMatchObject({
        name: "WeldallBrowserError",
        code: "key-loss",
        recovery: expect.any(String),
      });
  });

  it("cryptographically rejects a private key that does not match the stored public JWK", async () => {
    const databaseName = `mismatch-${crypto.randomUUID()}`;
    const first = await keyRecord(databaseName);
    const second = await keyRecord(`unused-${crypto.randomUUID()}`);
    await first.store.write({
      ...first.base,
      privateKey: second.pair.privateKey,
      refreshToken: "refresh",
      connectionId: "connection",
      subject: "subject",
      refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(client(databaseName).getConnectionStatus()).resolves.toEqual({
      state: "invalid",
      verified: "local",
      reason: "missing-key",
    });
    await expect(
      client(databaseName).request(`${origin}/api/data`, { scopes: ["resource:read"] }),
    ).rejects.toBeInstanceOf(WeldallBrowserError);
  });

  it("does not claim remote verification when local state prevents a network request", async () => {
    const fetcher = vi.fn();
    await expect(
      client(`remote-empty-${crypto.randomUUID()}`, fetcher).getConnectionStatus({
        verify: "remote",
      }),
    ).resolves.toEqual({ state: "disconnected", verified: "local" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails the public guard before discovery when the browser is unsupported", async () => {
    replace("isSecureContext", false);
    const fetcher = vi.fn();
    await expect(
      client(`unsupported-${crypto.randomUUID()}`, fetcher).getConnectionStatus(),
    ).rejects.toMatchObject({ code: "unsupported-browser" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["removed origin", "disabled resource"])(
    "maps terminal refresh CORS for a %s to origin-changed after a reachability probe",
    async () => {
      const databaseName = `terminal-cors-${crypto.randomUUID()}`;
      await connectedRecord(databaseName);
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.mode === "no-cors") return new Response(null, { status: 200 });
        if (url.endsWith("/.well-known/oauth-authorization-server"))
          return Response.json(discovery);
        if (url.endsWith("/api/auth/oauth2/token")) throw new TypeError("CORS blocked");
        throw new Error(`Unexpected request ${url}`);
      });
      await expect(
        client(databaseName, fetcher).getConnectionStatus({ verify: "remote" }),
      ).resolves.toEqual({ state: "invalid", verified: "remote", reason: "origin-changed" });
      expect(fetcher).toHaveBeenCalledWith(
        `${issuer}/.well-known/oauth-authorization-server`,
        expect.objectContaining({ mode: "no-cors", credentials: "omit" }),
      );
    },
  );

  it("maps terminal status CORS only after a successful DPoP refresh", async () => {
    const databaseName = `status-cors-${crypto.randomUUID()}`;
    const keyed = await connectedRecord(databaseName);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.mode === "no-cors") return new Response(null, { status: 200 });
      if (url.endsWith("/.well-known/oauth-authorization-server")) return Response.json(discovery);
      if (url.endsWith("/api/auth/oauth2/token"))
        return Response.json({
          access_token: accessToken(keyed.base),
          refresh_token: "rotated-refresh",
          token_type: "DPoP",
        });
      if (url.endsWith("/api/me/browser-connections/current")) throw new TypeError("CORS blocked");
      throw new Error(`Unexpected request ${url}`);
    });
    await expect(
      client(databaseName, fetcher).getConnectionStatus({ verify: "remote" }),
    ).resolves.toEqual({ state: "invalid", verified: "remote", reason: "origin-changed" });
  });

  it("does not misclassify a misconfigured or offline network as an origin change", async () => {
    const misconfigured = `misconfigured-${crypto.randomUUID()}`;
    await connectedRecord(misconfigured);
    const unavailable = vi.fn(async () => {
      throw new TypeError("network route unavailable");
    });
    await expect(
      client(misconfigured, unavailable).getConnectionStatus({ verify: "remote" }),
    ).rejects.toMatchObject({ code: "cors" });

    const offline = `offline-${crypto.randomUUID()}`;
    await connectedRecord(offline);
    replace("navigator", {
      onLine: false,
      locks: {
        request: async (_name: string, _options: unknown, callback: () => unknown) => callback(),
      },
    });
    await expect(
      client(offline, unavailable).getConnectionStatus({ verify: "remote" }),
    ).rejects.toMatchObject({ code: "network" });
  });
});
