import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestConnectionApi,
  requestConnection,
  listConnectors,
  showConnectionAttempt,
  validateConnectionTarget,
} from "../src/services/connections.js";
import type { WeldallConfig } from "../src/config.js";
import { canonicalServerManifest, newLock, serverManifest } from "../src/iac/manifest.js";

vi.mock("@weldall/sdk", async (original) => ({
  ...(await original<object>()),
  createDpopProof: vi.fn().mockResolvedValue("weldall-proof"),
}));
vi.mock("../src/services/auth.js", () => ({
  withAccess: (_config: unknown, operation: (session: unknown) => unknown) =>
    operation({ accessToken: "weldall-token", credentials: { refreshToken: "weldall-refresh" } }),
}));
const config = { issuer: "https://weldall.example.com" } as WeldallConfig;
const connection = {
  id: "connection-id",
  ownerId: "owner",
  connectorId: "connector",
  name: "my-google",
  accountId: "account",
  accountName: "account@example.com",
  selectedScopes: ["openid"],
  grantedScopes: ["openid"],
  status: "READY",
  version: 1,
  lastUsedAt: null,
  requestCount: 0,
  revocationError: null,
  createdAt: "now",
  updatedAt: "now",
  connectorKey: "google",
  connectorEnabled: true,
};
const scope = {
  id: "openid",
  label: "Identity",
  description: "Required identity scope.",
  group: "Identity",
  required: true,
};
afterEach(() => vi.unstubAllGlobals());

describe("managed connection CLI", () => {
  it("sends credentials only to Weldall and the provider URL only as untrusted metadata", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(connection))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetcher);
    const url = "https://gmail.googleapis.com/future/arbitrary/path?newParam=yes";
    const response = await requestConnection({
      config,
      selector: "my-google",
      input: {
        url,
        method: "POST",
        json: { summary: "Meeting" },
        headers: {
          "x-weldall-upstream-url": "https://evil.example",
          "x-weldall-connection": "other",
        },
      },
    });
    expect(await response.json()).toEqual({ items: [] });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${config.issuer}/api/me/connections/my-google`);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${config.issuer}/connectors/google`);
    const options = fetcher.mock.calls[1]![1];
    expect(options.headers.get("authorization")).toBe("DPoP weldall-token");
    expect(options.headers.get("x-weldall-connection")).toBe(connection.id);
    expect(options.headers.get("x-weldall-upstream-url")).toBe(url);
    expect(options.headers.has("x-weldall-required-scope")).toBe(false);
    expect(options.body).toBe('{"summary":"Meeting"}');
    expect(options.redirect).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const target of [
      "http://gmail.googleapis.com/a",
      "https://user:pass@google.com/a",
      `${url}#fragment`,
      "not a URL",
    ])
      expect(() => validateConnectionTarget(target)).toThrow();
    // Client checks are not authorization; the adapter rejects this origin on the server.
    expect(() => validateConnectionTarget("https://evil.example/a")).not.toThrow();
  });
  it("polls metadata only through Weldall", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "COMPLETED", connection: { id: "connection" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await requestConnectionApi({ config, path: "connection-authorizations/attempt" }),
    ).toMatchObject({ status: "COMPLETED" });
    expect(fetcher.mock.calls[0]![0]).toBe(
      `${config.issuer}/api/me/connection-authorizations/attempt`,
    );
  });
  it("accepts provider scope descriptors and selection without capabilities", async () => {
    const connector = {
      key: "google",
      name: "Google",
      type: "google",
      scopes: [scope],
      defaultScopes: [],
    };
    const attempt = {
      id: "attempt",
      status: "SETUP",
      connector: { key: "google", name: "Google", version: 2 },
      scopes: [scope],
      selection: { scopes: ["openid"] },
      expiresAt: "now",
      connection: null,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([connector]))
        .mockResolvedValueOnce(Response.json(attempt))
        .mockResolvedValueOnce(
          Response.json({ ...attempt, scopes: [{ ...scope, required: "yes" }] }),
        ),
    );
    await expect(listConnectors(config)).resolves.toEqual([connector]);
    await expect(showConnectionAttempt({ config, id: "attempt" })).resolves.toEqual(attempt);
    await expect(showConnectionAttempt({ config, id: "attempt" })).rejects.toThrow(
      "invalid connection setup status",
    );
  });
  it("canonicalizes provider configuration and rejects removed fields, secrets and unsupported types", () => {
    const read = "https://www.googleapis.com/auth/gmail.readonly";
    const google = {
      key: "google",
      name: "Google",
      type: "google",
      enabled: false,
      envelopeProvider: "LOCAL_ENV",
      provider: { clientId: "client", allowedScopes: [read], defaultScopes: [] },
    };
    const manifest = {
      apiVersion: "weldall.dev/v1" as const,
      workspace: { name: "test", issuer: config.issuer },
      connectors: { google },
    };
    expect(serverManifest(manifest, newLock(manifest)).connectors).toEqual(manifest.connectors);
    expect(canonicalServerManifest(manifest).connectors).toEqual(manifest.connectors);
    for (const extra of [
      { enabledApis: ["gmail"] },
      { clientId: "flat" },
      { clientSecret: "secret" },
      { envelopeProvider: "OPENBAO" },
      { type: "unknown" },
      { provider: { ...google.provider, clientSecret: "secret" } },
      { provider: { ...google.provider, enabledApis: ["gmail"] } },
      { provider: { ...google.provider, allowedScopes: ["unknown"] } },
    ]) {
      expect(() =>
        serverManifest(
          { ...manifest, connectors: { google: { ...google, ...extra } } },
          newLock(manifest),
        ),
      ).toThrow();
    }
    expect(
      canonicalServerManifest({
        ...manifest,
        connectors: {
          google: { ...google, provider: { ...google.provider, allowedScopes: [read, read] } },
        },
      }).connectors,
    ).toEqual(manifest.connectors);
  });
});
