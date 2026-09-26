import { createCipheriv } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt, decrypt, saveSecret } from "../src/server/connectors/encryption";
import { getEnvelopeProvider } from "../src/server/connectors/envelope-providers";
import { connectorConfig } from "../src/server/connectors/contracts";
import { saveConnectorConfiguration } from "../src/server/connectors/configuration";
import { parseDesiredState } from "../src/server/iac/contracts";
import { seal, unseal } from "../src/server/auth/oidc-credentials";
import {
  decryptProviderToken,
  encryptProviderToken,
} from "../src/server/group-providers/credentials";

const context = "connection:stable-record-id:credentials";
const credentials = {
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: 12345,
  grantedScopes: ["openid", "email"],
};
const write = (record = context) =>
  encrypt({ provider: "LOCAL_ENV", plaintext: JSON.stringify(credentials), context: record });
const config = {
  key: "google",
  name: "Google",
  type: "google",
  enabled: false,
  envelopeProvider: "LOCAL_ENV",
  requiredScopes: [],
  provider: {
    clientId: "client",
    allowedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    defaultScopes: [],
  },
};
const manifest = (value: unknown) => ({
  apiVersion: "weldall.dev/v1",
  workspace: {
    id: "67ade6dc-0000-4000-8000-000000000000",
    name: "test",
    issuer: "https://weldall.example.com",
  },
  connectors: { google: value },
});

beforeEach(() => {
  vi.stubEnv("WELDALL_CONNECTOR_KEK", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("connector envelope encryption", () => {
  it("round-trips one combined object and uses fresh DEKs for every write, owner, and connector", async () => {
    const records = [
      context,
      context,
      ...["connector-a", "connector-b"].flatMap((connector) =>
        ["user-a", "user-b"].map((user) => `connection:${connector}-${user}:credentials`),
      ),
    ];
    const envelopes = await Promise.all(records.map(write));
    const deks = await Promise.all(
      envelopes.map((envelope) =>
        getEnvelopeProvider(envelope.provider).unwrapDek({
          wrappedDek: envelope.wrappedDek,
          context: envelope,
        }),
      ),
    );
    expect(new Set(deks.map((dek) => dek.toString("base64"))).size).toBe(records.length);
    expect(new Set(envelopes.map((envelope) => JSON.stringify(envelope.wrappedDek))).size).toBe(
      records.length,
    );
    for (const [index, envelope] of envelopes.entries()) {
      expect(JSON.parse(await decrypt({ envelope, context: records[index]! }))).toEqual(
        credentials,
      );
      const stored = JSON.stringify(envelope);
      expect(stored).not.toContain(credentials.accessToken);
      expect(stored).not.toContain(credentials.refreshToken);
      for (const dek of deks) expect(stored).not.toContain(dek.toString("base64"));
    }
    deks.forEach((dek) => dek.fill(0));
  });
  it.each(["ciphertext", "nonce", "tag"] as const)("authenticates data %s", async (field) => {
    const envelope = await write();
    const bytes = Buffer.from(envelope[field], "base64");
    bytes[0] = bytes[0]! ^ 1;
    await expect(
      decrypt({ envelope: { ...envelope, [field]: bytes.toString("base64") }, context }),
    ).rejects.toThrow("unavailable");
  });
  it.each(["ciphertext", "nonce", "tag"] as const)(
    "authenticates wrapped DEK %s",
    async (field) => {
      const envelope = await write();
      const bytes = Buffer.from(envelope.wrappedDek[field]!, "base64");
      bytes[0] = bytes[0]! ^ 1;
      await expect(
        decrypt({
          envelope: {
            ...envelope,
            wrappedDek: { ...envelope.wrappedDek, [field]: bytes.toString("base64") },
          },
          context,
        }),
      ).rejects.toThrow("unavailable");
    },
  );
  it("rejects purpose, entity, provider, format and wrapped-DEK substitution", async () => {
    const envelope = await write();
    for (const target of [
      "connection:another-record:credentials",
      "connection:stable-record-id:oauth",
    ]) {
      await expect(decrypt({ envelope, context: target })).rejects.toThrow("unavailable");
      await expect(
        decrypt({ envelope: { ...envelope, context: target }, context: target }),
      ).rejects.toThrow("unavailable");
    }
    for (const provider of ["OPENBAO", "unknown"])
      await expect(
        decrypt({ envelope: { ...envelope, provider } as never, context }),
      ).rejects.toThrow("unavailable");
    await expect(decrypt({ envelope: { ...envelope, formatVersion: 2 }, context })).rejects.toThrow(
      "unavailable",
    );
    const other = await write();
    await expect(
      decrypt({ envelope: { ...envelope, wrappedDek: other.wrappedDek }, context }),
    ).rejects.toThrow("unavailable");
  });
  it.each([
    undefined,
    "",
    "invalid-private-key",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(32).toString("base64") + "\n",
  ])("fails closed with missing or invalid KEK (%#)", async (key) => {
    const envelope = await write();
    vi.stubEnv("WELDALL_CONNECTOR_KEK", key);
    await expect(write()).rejects.toThrow("unavailable");
    await expect(decrypt({ envelope, context })).rejects.toThrow("unavailable");
  });
  it("rejects a replaced KEK without exposing the key or tokens in errors", async () => {
    const envelope = await write();
    vi.stubEnv("WELDALL_CONNECTOR_KEK", Buffer.alloc(32, 8).toString("base64"));
    await expect(decrypt({ envelope, context })).rejects.toMatchObject({
      code: "key_unavailable",
      message:
        "Encryption material is unavailable or changed. Restore the original deployment secrets.",
    });
  });
  it("persists only envelopes and replaces the entire object with fresh material", async () => {
    const tx = {
      encryptedValue: {
        create: vi.fn(({ data }) => ({ id: "record", ...data })),
        update: vi.fn(({ data }) => ({ id: "record", ...data })),
      },
    };
    const first = await saveSecret({
      tx: tx as never,
      provider: "LOCAL_ENV",
      context,
      value: JSON.stringify(credentials),
    });
    const second = await saveSecret({
      tx: tx as never,
      provider: "LOCAL_ENV",
      context,
      value: JSON.stringify({ ...credentials, refreshToken: "replacement" }),
      id: first.id,
    });
    expect(second.wrappedDek).not.toEqual(first.wrappedDek);
    expect(JSON.stringify(tx.encryptedValue.create.mock.calls)).not.toMatch(
      /private-access|private-refresh/,
    );
    expect(JSON.stringify(tx.encryptedValue.update.mock.calls)).not.toContain("replacement");
    expect(JSON.parse(await decrypt({ envelope: second, context })).refreshToken).toBe(
      "replacement",
    );
  });
});

describe("provider contracts", () => {
  it("accepts only explicit LOCAL_ENV on server and IaC", () => {
    expect(connectorConfig.parse(config).envelopeProvider).toBe("LOCAL_ENV");
    expect(parseDesiredState(manifest(config)).connectors.google?.envelopeProvider).toBe(
      "LOCAL_ENV",
    );
    for (const envelopeProvider of [undefined, "OPENBAO", "unknown"])
      expect(() => parseDesiredState(manifest({ ...config, envelopeProvider }))).toThrow();
    for (const extra of [
      { variable: "ARBITRARY_ENV" },
      { providerConfig: {} },
      { source: { variable: "ARBITRARY_ENV" } },
      { clientSecret: "private" },
    ]) {
      expect(() => connectorConfig.parse({ ...config, ...extra })).toThrow();
      expect(() => parseDesiredState(manifest({ ...config, ...extra }))).toThrow();
    }
  });
  it("enforces immutability in the shared mutation, independently of the UI", async () => {
    const tx = {
      connector: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          ...config,
          id: "id",
          version: 1,
          envelopeProvider: "OPENBAO",
          requiredScopes: [],
        }),
        update: vi.fn(),
      },
    };
    await expect(
      saveConnectorConfiguration({
        tx: tx as never,
        value: config,
        id: "id",
        expectedVersion: 1,
        actor: { id: "admin", requestId: "r" },
      }),
    ).rejects.toMatchObject({ code: "immutable_provider" });
    expect(tx.connector.update).not.toHaveBeenCalled();
  });
});

describe("fixed application encryption", () => {
  it("keeps OAuth client secrets independent of connector KEKs and bound to purpose and ID", () => {
    const value = seal("connector-provider-secrets", "connector", "client-secret");
    vi.stubEnv("WELDALL_CONNECTOR_KEK", undefined);
    expect(unseal("connector-provider-secrets", "connector", value)).toBe("client-secret");
    expect(() => unseal("provider", "connector", value)).toThrow();
    expect(() => unseal("connector-provider-secrets", "other", value)).toThrow();
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 10).toString("base64"));
    expect(() => unseal("connector-provider-secrets", "connector", value)).toThrow();
  });
  it.each([1, 7])(
    "reads existing main group-provider ciphertext with stored AAD marker %i",
    (keyVersion) => {
      const nonce = Buffer.alloc(12, 3);
      const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 9), nonce);
      cipher.setAAD(Buffer.from(`group-provider-token\0legacy-id\0${keyVersion}`));
      const ciphertext = Buffer.concat([cipher.update("legacy-token"), cipher.final()]);
      const encryptedToken = JSON.stringify({
        version: 1,
        algorithm: "A256GCM",
        keyVersion,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      });
      expect(
        decryptProviderToken({ id: "legacy-id", encryptedToken, encryptionKeyVersion: keyVersion }),
      ).toBe("legacy-token");
      const next = encryptProviderToken("legacy-id", "new-token");
      expect(next.encryptionKeyVersion).toBe(1);
      expect(decryptProviderToken({ id: "legacy-id", ...next })).toBe("new-token");
    },
  );
});
