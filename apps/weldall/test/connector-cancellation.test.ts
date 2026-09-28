import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  deleteValue: vi.fn(),
  disconnect: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@weldall/db", () => ({
  db: {
    connectionAuthorization: {
      findUnique: mocks.findUnique,
      findUniqueOrThrow: mocks.findUnique,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
    encryptedValue: { delete: mocks.deleteValue },
  },
  Prisma: {},
}));
vi.mock("../src/server/connectors/configuration", async () => {
  const { db } = await import("@weldall/db");
  return {
    runConnectorTransaction: (operation: (tx: unknown) => unknown) => operation(db),
    readConnectorSecrets: () => ({}),
  };
});
vi.mock("../src/server/connectors/encryption", () => ({
  loadSecretEnvelope: vi.fn(async () => ({})),
  decryptSecretEnvelope: vi.fn(async () =>
    JSON.stringify({ attempt: {}, credentials: { token: "encrypted-provider-token" } }),
  ),
}));
vi.mock("../src/server/connectors/registry", () => ({
  getConnectorProvider: () => ({ disconnectGrant: mocks.disconnect }),
}));
vi.mock("../src/server/connectors/audit", () => ({ writeConnectorAuditLog: mocks.audit }));
vi.mock("../src/server/policy/resources", () => ({
  effectiveScopesRequiringSystemScopeFor: vi.fn(),
}));
import { cancelAuthorizationAttempt } from "../src/server/connectors/core/connections";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({
    id: "attempt",
    ownerId: "owner",
    connectorId: "connector",
    status: "NEEDS_REVOCATION",
    payloadId: "payload",
    connector: { providerType: "test-provider" },
  });
  mocks.updateMany.mockResolvedValue({ count: 1 });
});
describe("provider-neutral failed-authorization cleanup", () => {
  const cancel = () =>
    cancelAuthorizationAttempt({ actor: { id: "owner", requestId: "request" }, id: "attempt" });
  it("cleans local credentials with a warning when remote revocation is unsupported", async () => {
    mocks.disconnect.mockResolvedValue({ status: "unsupported" });
    expect(await cancel()).toMatchObject({
      message: expect.stringContaining("revocation is unsupported"),
    });
    expect(mocks.deleteValue).toHaveBeenCalledWith({ where: { id: "payload" } });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "authorization.cancelled_revocation_unsupported" }),
    );
  });
  it.each(["unconfirmed", "unknown"])(
    "retains credentials for a non-confirmed revocation result: %s",
    async (status) => {
      mocks.disconnect.mockResolvedValue({ status });
      await expect(cancel()).rejects.toMatchObject({ code: "revocation_unconfirmed" });
      expect(mocks.deleteValue).not.toHaveBeenCalled();
    },
  );
  it("preserves the confirmed-revocation path", async () => {
    mocks.disconnect.mockResolvedValue({ status: "revoked" });
    expect(await cancel()).toEqual({});
    expect(mocks.deleteValue).toHaveBeenCalledOnce();
  });
  it("rejects nonowners before touching credentials", async () => {
    await expect(
      cancelAuthorizationAttempt({
        actor: { id: "attacker", requestId: "request" },
        id: "attempt",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.deleteValue).not.toHaveBeenCalled();
  });
});
