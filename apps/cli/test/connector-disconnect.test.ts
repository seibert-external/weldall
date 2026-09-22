import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  keychain: {
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("jose", () => ({ calculateJwkThumbprint: vi.fn(async () => "device-id") }));
vi.mock("@weldall/sdk", () => ({
  createDpopProof: vi.fn(async () => "proof"),
}));
vi.mock("../src/services/auth.js", () => ({
  withAccess: vi.fn(async (_config, callback) =>
    callback({
      accessToken: "access-token",
      subject: "user-1",
      credentials: { privateJwk: {}, publicJwk: {} },
    }),
  ),
}));
vi.mock("../src/oauth/session.js", () => ({
  validateConnectionLease: vi.fn(async () => undefined),
}));
vi.mock("../src/storage/keychain.js", () => ({ personalConnectionKeychain: mocks.keychain }));

const { disconnectConnection, listConnections, listConnectors, prepareConnectionClient } =
  await import("../src/services/connectors.js");

const config = { issuer: "https://weldall.example.com" } as never;
const connection = {
  id: "connection-1",
  name: "work-google",
  connectorId: "connector-1",
  connectorKey: "google",
  connectorName: "Google",
  account: { id: "account-1", displayName: "person@example.com" },
  deviceId: "device-id",
  status: "ready" as const,
  enabledApis: ["calendar"],
  grantedScopes: ["calendar.readonly"],
  allowedTargetPrefixes: ["https://www.googleapis.com/calendar/v3/"],
  connectedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  version: 2,
};
const credentials = {
  refreshToken: "refresh-token",
  accessToken: "provider-access-token",
  expiresAt: 1,
  grantedScopes: ["calendar.readonly"],
  tokenType: "Bearer",
};

const json = (value: unknown, status = 200) => Response.json(value, { status });

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("personal connection contracts", () => {
  it("reads personal connection metadata without a credential mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ connections: [connection] })),
    );

    await expect(listConnections(config)).resolves.toEqual([connection]);
    expect(mocks.keychain.get).not.toHaveBeenCalled();
  });

  it("discovers connector configuration without credential modes", async () => {
    const connector = {
      id: connection.connectorId,
      key: connection.connectorKey,
      name: connection.connectorName,
      type: "google",
      enabledApis: connection.enabledApis,
      oauthScopes: connection.grantedScopes,
      allowedTargetPrefixes: connection.allowedTargetPrefixes,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ connectors: [connector] })),
    );

    await expect(listConnectors(config)).resolves.toEqual([connector]);
    expect(mocks.keychain.get).not.toHaveBeenCalled();
  });
});

describe("connection deletion cleanup", () => {
  it("requests provider revocation and clears local credentials after server deletion", async () => {
    mocks.keychain.get.mockResolvedValue(credentials);
    const fetcher = vi.fn(async () =>
      json({
        id: connection.id,
        name: connection.name,
        providerRevocation: "confirmed",
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(disconnectConnection(config, connection)).resolves.toEqual({
      id: connection.id,
      name: connection.name,
      providerRevocation: "confirmed",
    });

    expect(fetcher).toHaveBeenCalledWith(
      `${config.issuer}/api/me/connections/${connection.id}/disconnect`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "refresh-token" }),
      }),
    );
    expect(mocks.keychain.clear).toHaveBeenCalledWith(config.issuer, connection.id);
  });

  it("still clears local credentials when provider revocation could not be confirmed", async () => {
    mocks.keychain.get.mockResolvedValue(credentials);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          id: connection.id,
          name: connection.name,
          providerRevocation: "failed",
        }),
      ),
    );

    await expect(disconnectConnection(config, connection)).resolves.toMatchObject({
      providerRevocation: "failed",
    });
    expect(mocks.keychain.clear).toHaveBeenCalledWith(config.issuer, connection.id);
  });

  it("clears stale local credentials when a prepared client learns the connection was deleted", async () => {
    mocks.keychain.get.mockResolvedValue(credentials);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(connection))
      .mockResolvedValueOnce(
        json({ error: "not_found", error_description: "Connection was not found." }, 404),
      );
    vi.stubGlobal("fetch", fetcher);

    const client = await prepareConnectionClient(
      config,
      connection.name,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    await expect(
      client.request({
        method: "GET",
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        headers: {},
      }),
    ).rejects.toThrow('Connection "work-google" was removed');

    expect(mocks.keychain.clear).toHaveBeenCalledWith(config.issuer, connection.id);
  });
});
