import { afterEach, describe, expect, it, vi } from "vitest";
import { sealConnectorValue } from "../src/server/connectors/credentials.js";

const mocks = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    auditEvent: { create: vi.fn() },
    connector: { findFirst: vi.fn(), findMany: vi.fn() },
    personalConnectionAuthorization: {
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    personalConnection: {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@weldall/db", () => ({
  db: mocks.db,
  Prisma: {
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
  },
}));

const {
  consumeAuthorizationCredentials,
  disconnectUserConnection,
  getUserConnection,
  listAvailableConnectors,
  listUserConnections,
  startConnectionAuthorization,
} = await import("../src/server/connectors/personal-connection-service.js");

const ownerId = "user-1";
const deviceId = "device-id-123456789012";
const authorizationId = "authorization-1";
const connection = {
  id: "connection-1",
  connectorId: "connector-1",
  ownerId,
  name: "calendar",
  providerAccountId: "google-account",
  accountDisplayName: "Google Account",
  deviceId,
  status: "READY",
  grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  connectedAt: new Date("2026-01-01T00:00:00.000Z"),
  lastLeaseAt: null,
  version: 1,
  owner: { email: "user@example.com" },
  connector: {
    id: "connector-1",
    key: "google",
    name: "Google",
    type: "google",
    enabled: true,
    enabledApis: ["calendar"],
    oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    oauthClientId: "client-id",
    encryptedOAuthClientSecret: "secret",
  },
};
const actor = {
  id: ownerId,
  email: "user@example.com",
  requestId: "personal-connection-service-test",
};

function authorizationPayload() {
  return sealConnectorValue(
    "authorization",
    authorizationId,
    JSON.stringify({
      nonce: "n".repeat(20),
      codeVerifier: "v".repeat(43),
      deviceId,
      connectionVersion: null,
    }),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("connector authorization lifecycle", () => {
  it("keeps initial authorization temporary until the callback succeeds", async () => {
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const connector = {
      ...connection.connector,
      encryptedOAuthClientSecret: sealConnectorValue(
        "connector-config",
        connection.connector.id,
        "client-secret",
      ),
    };
    mocks.db.$transaction.mockImplementation(async (operation) => operation(mocks.db));
    mocks.db.connector.findFirst.mockResolvedValue(connector);
    mocks.db.personalConnection.findFirst.mockResolvedValue(null);
    mocks.db.personalConnectionAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.personalConnectionAuthorization.create.mockResolvedValue({ id: authorizationId });
    mocks.db.personalConnectionAuthorization.update.mockResolvedValue({ id: authorizationId });
    mocks.db.auditEvent.create.mockResolvedValue({});

    await expect(
      startConnectionAuthorization({ connector: connector.key, name: "calendar", deviceId }, actor),
    ).resolves.toMatchObject({
      authorizationId,
      connectionName: "calendar",
      mode: "connect",
      authorizationUrl: expect.stringContaining("https://accounts.google.com/"),
    });
    expect(mocks.db.personalConnectionAuthorization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          connectorId: connector.id,
          ownerId,
          connectionName: "calendar",
          mode: "connect",
        }),
      }),
    );
  });

  it("keeps pending polls read-only and consumes completed credentials once", async () => {
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    mocks.db.personalConnectionAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.personalConnectionAuthorization.findFirst.mockResolvedValue({
      id: authorizationId,
      connectionId: connection.id,
      ownerId,
      encryptedPayload: authorizationPayload(),
      callbackConsumedAt: null,
      completedAt: null,
      credentialsConsumedAt: null,
      encryptedCredentials: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      consumeAuthorizationCredentials(ownerId, authorizationId, deviceId),
    ).rejects.toMatchObject({ code: "authorization_pending", status: 202 });
    expect(mocks.db.personalConnectionAuthorization.updateMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const credentials = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 1_767_225_600,
      grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      tokenType: "Bearer" as const,
    };
    mocks.db.personalConnectionAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.personalConnectionAuthorization.findFirst.mockResolvedValue({
      id: authorizationId,
      connectionId: connection.id,
      ownerId,
      encryptedPayload: authorizationPayload(),
      callbackConsumedAt: new Date(),
      completedAt: new Date(),
      credentialsConsumedAt: null,
      encryptedCredentials: sealConnectorValue(
        "handoff",
        authorizationId,
        JSON.stringify(credentials),
      ),
      expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.db.personalConnection.findFirst.mockResolvedValue(connection);
    mocks.db.personalConnectionAuthorization.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      consumeAuthorizationCredentials(ownerId, authorizationId, deviceId),
    ).resolves.toEqual(expect.objectContaining({ credentials }));
    expect(mocks.db.personalConnectionAuthorization.updateMany).toHaveBeenCalledWith({
      where: {
        id: authorizationId,
        completedAt: { not: null },
        encryptedCredentials: { not: null },
        credentialsConsumedAt: null,
      },
      data: { credentialsConsumedAt: expect.any(Date), encryptedCredentials: null },
    });
  });
});

describe("personal connection contracts", () => {
  it("lists only the owner's personal connections without a credential mode", async () => {
    mocks.db.personalConnectionAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.personalConnection.findMany.mockResolvedValue([connection]);

    const result = await listUserConnections(ownerId);

    expect(mocks.db.personalConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: connection.id,
      deviceId,
      account: { id: connection.providerAccountId },
    });
    expect(result[0]).not.toHaveProperty("credentialMode");
    expect(result[0]).not.toHaveProperty("credentials");
  });

  it("requires ownership for both ID and name lookup", async () => {
    mocks.db.personalConnectionAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.personalConnection.findFirst.mockResolvedValue(null);

    await expect(getUserConnection("another-user", connection.id)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(mocks.db.personalConnection.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { ownerId: "another-user", id: connection.id } }),
    );
    expect(mocks.db.personalConnection.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { ownerId: "another-user", name: connection.id } }),
    );
  });

  it("discovers reusable connector configuration without credential modes or secrets", async () => {
    mocks.db.connector.findMany.mockResolvedValue([connection.connector]);

    const result = await listAvailableConnectors();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: connection.connectorId, type: "google" });
    expect(result[0]).not.toHaveProperty("credentialModes");
    expect(result[0]).not.toHaveProperty("encryptedOAuthClientSecret");
  });
});

describe("personal connection deletion", () => {
  function configuredConnection() {
    return {
      ...connection,
      connector: {
        ...connection.connector,
        encryptedOAuthClientSecret: sealConnectorValue(
          "connector-config",
          connection.connector.id,
          "client-secret",
        ),
      },
    };
  }

  it("deletes the server record before best-effort provider revocation", async () => {
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const ready = configuredConnection();
    mocks.db.$transaction.mockImplementation(async (operation) => operation(mocks.db));
    mocks.db.$queryRaw.mockResolvedValue([]);
    mocks.db.auditEvent.create.mockResolvedValue({});
    mocks.db.personalConnectionAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.personalConnection.findFirst.mockResolvedValue(ready);
    mocks.db.personalConnection.findUnique.mockResolvedValue(ready);
    mocks.db.personalConnection.deleteMany.mockResolvedValue({ count: 1 });
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(
      disconnectUserConnection(ownerId, ready.id, "refresh-token", actor),
    ).resolves.toEqual({
      id: ready.id,
      name: ready.name,
      providerRevocation: "failed",
    });
    expect(mocks.db.personalConnection.deleteMany).toHaveBeenCalledWith({
      where: { id: ready.id, ownerId },
    });
    expect(mocks.db.personalConnection.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      fetcher.mock.invocationCallOrder[0]!,
    );
  });

  it("deletes immediately when no device credential is available", async () => {
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const ready = configuredConnection();
    mocks.db.$transaction.mockImplementation(async (operation) => operation(mocks.db));
    mocks.db.$queryRaw.mockResolvedValue([]);
    mocks.db.auditEvent.create.mockResolvedValue({});
    mocks.db.personalConnectionAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.personalConnection.findFirst.mockResolvedValue(ready);
    mocks.db.personalConnection.findUnique.mockResolvedValue(ready);
    mocks.db.personalConnection.deleteMany.mockResolvedValue({ count: 1 });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(disconnectUserConnection(ownerId, ready.id, undefined, actor)).resolves.toEqual({
      id: ready.id,
      name: ready.name,
      providerRevocation: "not_requested",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
