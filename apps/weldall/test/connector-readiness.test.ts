import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyConnectorEncryption } from "../src/server/deployment";
import { encrypt } from "../src/server/connectors/encryption";
import { seal } from "../src/server/auth/oidc-credentials";

beforeEach(() => {
  vi.stubEnv("WELDALL_CONNECTOR_KEK", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 2).toString("base64"));
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const envelope = await encrypt({
    provider: "LOCAL_ENV",
    context: "connection:record:credentials",
    plaintext: "private-token",
  });
  return {
    connector: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "connector",
            envelopeProvider: "LOCAL_ENV",
            encryptedClientSecret: seal("connector-client-secret", "connector", "client-secret"),
          },
        ])
        .mockResolvedValue([]),
    },
    encryptedValue: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([
          { id: "value", ...envelope, connection: { id: "record" }, attempt: null },
        ])
        .mockResolvedValue([]),
    },
  };
}

describe("connector deployment readiness", () => {
  it("validates both encryption layers and pages without loading all secrets", async () => {
    const prisma = await fixture();
    await verifyConnectorEncryption(prisma as never);
    expect(prisma.connector.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 100, cursor: { id: "connector" }, skip: 1 }),
    );
    expect(prisma.encryptedValue.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 100, cursor: { id: "value" }, skip: 1 }),
    );
  });
  it.each(["WELDALL_CONNECTOR_KEK", "WELDALL_CREDENTIAL_ENCRYPTION_KEY"])(
    "fails on replacement of %s",
    async (name) => {
      const prisma = await fixture();
      vi.stubEnv(name, Buffer.alloc(32, 3).toString("base64"));
      await expect(verifyConnectorEncryption(prisma as never)).rejects.toThrow(/unavailable/);
    },
  );
  it("requires a provisioned KEK even for an empty disabled connector", async () => {
    const prisma = {
      connector: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "id", envelopeProvider: "LOCAL_ENV", encryptedClientSecret: null },
          ]),
      },
    };
    vi.stubEnv("WELDALL_CONNECTOR_KEK", undefined);
    await expect(verifyConnectorEncryption(prisma as never)).rejects.toThrow("unavailable");
  });
});
