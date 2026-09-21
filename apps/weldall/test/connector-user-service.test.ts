import { afterEach, describe, expect, it, vi } from "vitest";
import { sealConnectorValue } from "../src/server/connectors/credentials.js";

const mocks = vi.hoisted(() => ({
  db: {
    connectorAuthorization: {
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    connectorConnection: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@weldall/db", () => ({
  db: mocks.db,
  Prisma: {
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
  },
}));

const { consumeAuthorizationCredentials } = await import(
  "../src/server/connectors/user-service.js"
);

const ownerId = "user-1";
const deviceId = "device-id-123456789012";
const connection = {
  id: "connection-1",
  connectorId: "connector-1",
  ownerId,
  name: "calendar",
  providerAccountId: "google-account",
  accountDisplayName: "Google Account",
  credentialMode: "local",
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

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("connector authorization credential handoff", () => {
  it("keeps pending polls read-only and consumes completed credentials once", async () => {
    mocks.db.connectorAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.connectorConnection.findFirst.mockResolvedValue(connection);
    mocks.db.connectorAuthorization.findFirst.mockResolvedValue({
      id: "authorization-1",
      callbackConsumedAt: null,
      completedAt: null,
      credentialsConsumedAt: null,
      encryptedCredentials: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      consumeAuthorizationCredentials(ownerId, "calendar", deviceId),
    ).rejects.toMatchObject({ code: "authorization_pending", status: 202 });
    expect(mocks.db.connectorAuthorization.updateMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const credentials = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 1_767_225_600,
      grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      tokenType: "Bearer" as const,
    };
    mocks.db.connectorAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.connectorConnection.findFirst.mockResolvedValue(connection);
    mocks.db.connectorAuthorization.findFirst.mockResolvedValue({
      id: "authorization-1",
      callbackConsumedAt: new Date(),
      completedAt: new Date(),
      credentialsConsumedAt: null,
      encryptedCredentials: sealConnectorValue(
        "handoff",
        "authorization-1",
        JSON.stringify(credentials),
      ),
      expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.db.connectorAuthorization.updateMany.mockResolvedValue({ count: 1 });

    await expect(consumeAuthorizationCredentials(ownerId, "calendar", deviceId)).resolves.toEqual(
      expect.objectContaining({ credentials }),
    );
    expect(mocks.db.connectorAuthorization.updateMany).toHaveBeenCalledWith({
      where: {
        id: "authorization-1",
        completedAt: { not: null },
        encryptedCredentials: { not: null },
        credentialsConsumedAt: null,
      },
      data: { credentialsConsumedAt: expect.any(Date), encryptedCredentials: null },
    });

    vi.clearAllMocks();
    mocks.db.connectorAuthorization.deleteMany.mockResolvedValue({ count: 0 });
    mocks.db.connectorConnection.findFirst.mockResolvedValue(connection);
    mocks.db.connectorAuthorization.findFirst.mockResolvedValue({
      id: "authorization-1",
      callbackConsumedAt: new Date(),
      completedAt: new Date(),
      credentialsConsumedAt: new Date(),
      encryptedCredentials: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      consumeAuthorizationCredentials(ownerId, "calendar", deviceId),
    ).rejects.toMatchObject({ code: "credentials_consumed", status: 410 });
    expect(mocks.db.connectorAuthorization.updateMany).not.toHaveBeenCalled();
  });
});
