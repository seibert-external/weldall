import { isDeepStrictEqual } from "node:util";
import {
  db,
  Prisma,
  type Connector,
  type EncryptionKey,
  type EncryptionKeyVersion,
} from "@weldall/db";
import {
  connectorConfig,
  encryptionKeyConfig,
  ConnectorError,
  type ConnectorActor,
  type ConnectorConfig,
  type KeyConfig,
} from "./contracts";
import { validateConnectorScopeConfig } from "./scopes";
import { decrypt, encrypt, readSecret, saveSecret } from "./encryption";
import {
  bindKeySource,
  checkKeyBindingAvailability,
  describeKeySource,
  resolveKeyMaterial,
} from "./key-providers";
import { writeConnectorAuditLog } from "./audit";

type Tx = Prisma.TransactionClient;

/** Runs connector writes with the serializable isolation required by lifecycle compare-and-set logic. */
export const runConnectorTransaction = <T>(operation: (tx: Tx) => Promise<T>) =>
  db.$transaction(operation, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 15_000,
  });

/** Ensures UI and IaC writes use the latest managed-connector configuration revision. */
export function assertConfigurationVersion({
  current,
  expected,
}: {
  current: { version: number } | null;
  expected: number | null;
}) {
  if ((current?.version ?? null) !== expected)
    throw new ConnectorError("conflict", "Configuration changed; reload and try again.", 409);
}

/** Projects an encryption-key row into the shared non-secret UI and IaC configuration contract. */
export function buildEncryptionKeyState(
  key: EncryptionKey & { versions: EncryptionKeyVersion[] },
): KeyConfig {
  return {
    key: key.key,
    name: key.name,
    activeVersion: key.activeVersion,
    versions: Object.fromEntries(
      key.versions.map((version) => [version.version, { source: describeKeySource(version) }]),
    ),
  };
}
/** Projects a connector row into the shared non-secret UI and IaC configuration contract. */
export function buildConnectorState(
  row: Connector & { encryptionKey: { key: string } },
): ConnectorConfig {
  return connectorConfig.parse({
    key: row.key,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    encryptionKey: row.encryptionKey.key,
    clientId: row.clientId,
    enabledApis: row.enabledApis,
    allowedScopes: row.allowedScopes,
    defaultScopes: row.defaultScopes,
  });
}
/**
 * Creates or updates one logical encryption key through the shared admin and IaC write path.
 * IaC ownership remains metadata, while historical provider bindings stay immutable for recovery.
 */
export async function saveEncryptionKeyConfiguration({
  tx,
  value,
  id,
  expectedVersion,
  actor,
}: {
  tx: Tx;
  value: unknown;
  id: string | undefined;
  expectedVersion: number | null;
  actor: ConnectorActor;
}) {
  const config = encryptionKeyConfig.parse(value);
  const current = id
    ? await tx.encryptionKey.findUniqueOrThrow({ where: { id }, include: { versions: true } })
    : null;
  assertConfigurationVersion({ current, expected: expectedVersion });
  if (current && current.key !== config.key)
    throw new ConnectorError("immutable_identity", "Key identity cannot change.", 409);
  if (
    current?.versions.some(
      (version) =>
        !isDeepStrictEqual(config.versions[version.version]?.source, describeKeySource(version)),
    )
  )
    throw new ConnectorError(
      "immutable_version",
      "Retain every historical version and its original source binding for recovery.",
      409,
    );
  for (const version of current?.versions ?? []) await resolveKeyMaterial(version);
  const versions = await Promise.all(
    Object.entries(config.versions)
      .filter(([version]) => !current?.versions.some((old) => old.version === version))
      .map(async ([version, { source }]) => ({ version, ...(await bindKeySource(source)) })),
  );
  if (current && isDeepStrictEqual(buildEncryptionKeyState(current), config)) return current;
  const row = current
    ? await tx.encryptionKey.update({
        where: { id: current.id, version: expectedVersion! },
        data: {
          name: config.name,
          activeVersion: config.activeVersion,
          version: { increment: 1 },
          updatedBy: actor.id,
        },
      })
    : await tx.encryptionKey.create({
        data: {
          key: config.key,
          name: config.name,
          activeVersion: config.activeVersion,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
  for (const version of versions)
    await tx.encryptionKeyVersion.create({ data: { keyId: row.id, ...version } });
  await writeConnectorAuditLog({
    tx,
    actor,
    event: "configuration",
    subjectId: row.id,
    operation: "key.saved",
  });
  return row;
}
/** Creates or updates a managed connector while preserving write-only OAuth client secrets. */
export async function saveConnectorConfiguration({
  tx,
  value,
  id,
  expectedVersion,
  actor,
}: {
  tx: Tx;
  value: unknown;
  id: string | undefined;
  expectedVersion: number | null;
  actor: ConnectorActor;
}) {
  const config = connectorConfig.parse(value);
  validateConnectorScopeConfig(config);
  const current = id
    ? await tx.connector.findUniqueOrThrow({ where: { id }, include: { encryptionKey: true } })
    : null;
  assertConfigurationVersion({ current, expected: expectedVersion });
  if (current && current.key !== config.key)
    throw new ConnectorError("immutable_identity", "Connector identity cannot change.", 409);
  const clientIdChanged = Boolean(current && current.clientId !== config.clientId);
  if (
    current &&
    clientIdChanged &&
    ((await tx.connection.count({ where: { connectorId: current.id } })) ||
      (await tx.connectionAuthorization.count({ where: { connectorId: current.id } })))
  )
    throw new ConnectorError(
      "in_use",
      "Disconnect and delete connections and attempts before changing the OAuth client.",
      409,
    );
  if (clientIdChanged && config.enabled)
    throw new ConnectorError(
      "missing_secret",
      "Provision the new OAuth client secret before enabling the connector.",
      409,
    );
  const key = await tx.encryptionKey.findUnique({ where: { key: config.encryptionKey } });
  if (!key) throw new ConnectorError("missing_key", "Encryption key does not exist.", 409);
  // Even disabled configurations must reference provisioned, approved key material.
  await encrypt({ tx, keyId: key.id, plaintext: "readiness", context: "readiness" });
  if (config.enabled) {
    if (!current?.secretId)
      throw new ConnectorError(
        "missing_secret",
        "Provision the OAuth client secret before enabling the connector.",
        409,
      );
    await readSecret({
      tx,
      id: current.secretId,
      context: `connector:${current.id}:client-secret`,
    });
  }
  if (current && isDeepStrictEqual(buildConnectorState(current), config)) return current;
  const { encryptionKey: _, ...fields } = config;
  const row = current
    ? await tx.connector.update({
        where: { id: current.id, version: expectedVersion! },
        data: {
          ...fields,
          encryptionKeyId: key.id,
          ...(clientIdChanged ? { secretId: null } : {}),
          version: { increment: 1 },
          updatedBy: actor.id,
        },
      })
    : await tx.connector.create({
        data: { ...fields, encryptionKeyId: key.id, createdBy: actor.id, updatedBy: actor.id },
      });
  if (clientIdChanged && current?.secretId)
    await tx.encryptedValue.delete({ where: { id: current.secretId } });
  await writeConnectorAuditLog({
    tx,
    actor,
    event: "configuration",
    subjectId: row.id,
    operation: "connector.saved",
  });
  return row;
}
/** Replaces the write-only OAuth client secret used by one managed connector. */
export async function saveConnectorClientSecret({
  id,
  secret,
  version,
  actor,
}: {
  id: string;
  secret: string;
  version: number;
  actor: ConnectorActor;
}) {
  if (!secret.trim() || secret.length > 10_000)
    throw new ConnectorError("invalid_secret", "A client secret is required.");
  return runConnectorTransaction(async (tx) => {
    const connector = await tx.connector.findUniqueOrThrow({ where: { id } });
    assertConfigurationVersion({ current: connector, expected: version });
    const encrypted = await saveSecret({
      tx,
      keyId: connector.encryptionKeyId,
      context: `connector:${id}:client-secret`,
      value: secret,
      id: connector.secretId,
    });
    await tx.connector.update({
      where: { id, version },
      data: { secretId: encrypted.id, version: { increment: 1 }, updatedBy: actor.id },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "configuration",
      subjectId: id,
      operation: "secret.provisioned",
    });
  });
}
/** Deletes an unused connector definition after lifecycle cleanup removes its dependent rows. */
export async function deleteConnectorConfiguration({
  tx,
  id,
  version,
  actor,
}: {
  tx: Tx;
  id: string;
  version: number;
  actor: ConnectorActor;
}) {
  if (
    (await tx.connection.count({ where: { connectorId: id } })) ||
    (await tx.connectionAuthorization.count({ where: { connectorId: id } }))
  )
    throw new ConnectorError(
      "in_use",
      "Remove disconnected connections and completed attempts first. Unconfirmed revocations must be retried.",
      409,
    );
  const row = await tx.connector.delete({ where: { id, version } });
  if (row.secretId) await tx.encryptedValue.delete({ where: { id: row.secretId } });
  await writeConnectorAuditLog({
    tx,
    actor,
    event: "configuration",
    subjectId: id,
    operation: "connector.deleted",
  });
}
/** Deletes an unused logical key after all connector and ciphertext references are gone. */
export async function deleteEncryptionKeyConfiguration({
  tx,
  id,
  version,
  actor,
}: {
  tx: Tx;
  id: string;
  version: number;
  actor: ConnectorActor;
}) {
  if (
    (await tx.connector.count({ where: { encryptionKeyId: id } })) ||
    (await tx.encryptedValue.count({ where: { keyId: id } }))
  )
    throw new ConnectorError(
      "in_use",
      "Key is still referenced. Re-encrypt explicitly before deletion; retain backup keys separately.",
      409,
    );
  await tx.encryptionKeyVersion.deleteMany({ where: { keyId: id } });
  await tx.encryptionKey.delete({ where: { id, version } });
  await writeConnectorAuditLog({
    tx,
    actor,
    event: "configuration",
    subjectId: id,
    operation: "key.deleted",
  });
}
/**
 * Re-encrypts every secret owned by one connector during explicit synchronous maintenance;
 * serializable conflicts roll back the complete ciphertext rewrite.
 */
export async function reencryptConnectorSecrets({
  id,
  version,
  actor,
}: {
  id: string;
  version: number;
  actor: ConnectorActor;
}) {
  return runConnectorTransaction(async (tx) => {
    const connector = await tx.connector.findUniqueOrThrow({ where: { id } });
    assertConfigurationVersion({ current: connector, expected: version });
    const values = await tx.encryptedValue.findMany({
      where: {
        OR: [
          { connector: { id } },
          { connection: { connectorId: id } },
          { attempt: { connectorId: id } },
        ],
      },
      take: 1001,
    });
    if (values.length > 1000)
      throw new ConnectorError(
        "maintenance_limit",
        "Too many values for synchronous maintenance. Arrange an explicit maintenance window.",
        409,
      );
    for (const value of values) {
      const plaintext = await decrypt({ tx, envelope: value, context: value.context });
      await tx.encryptedValue.update({
        where: { id: value.id, version: value.version },
        data: {
          ...(await encrypt({
            tx,
            keyId: connector.encryptionKeyId,
            plaintext,
            context: value.context,
          })),
          version: { increment: 1 },
        },
      });
    }
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "configuration",
      subjectId: id,
      operation: "connector.reencrypted",
    });
    return { count: values.length };
  });
}
/** Lists the non-secret configuration consumed by the managed-connector admin views. */
export async function listManagedConnectorConfiguration() {
  const [keys, connectors] = await Promise.all([
    db.encryptionKey.findMany({
      include: { versions: true, iacBinding: true },
      orderBy: { key: "asc" },
    }),
    db.connector.findMany({
      include: { encryptionKey: true, iacBinding: true },
      orderBy: { key: "asc" },
    }),
  ]);
  return {
    keys: await Promise.all(
      keys.map(async (key) => ({
        id: key.id,
        version: key.version,
        config: buildEncryptionKeyState(key),
        managed: Boolean(key.iacBinding),
        available: (await Promise.all(key.versions.map(checkKeyBindingAvailability))).every(
          Boolean,
        ),
      })),
    ),
    connectors: connectors.map((row) => ({
      id: row.id,
      version: row.version,
      config: buildConnectorState(row),
      managed: Boolean(row.iacBinding),
      secretConfigured: Boolean(row.secretId),
    })),
  };
}
