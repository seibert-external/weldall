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
import { validateScopeConfig } from "./scopes";
import { decrypt, encrypt, readSecret, saveSecret, sourceFingerprint } from "./encryption";
import { connectorAudit } from "./audit";

type Tx = Prisma.TransactionClient;
export const transaction = <T>(operation: (tx: Tx) => Promise<T>) =>
  db.$transaction(operation, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 15_000,
  });
export function checkVersion(current: { version: number } | null, expected: number | null) {
  if ((current?.version ?? null) !== expected)
    throw new ConnectorError("conflict", "Configuration changed; reload and try again.", 409);
}
export function keyState(key: EncryptionKey & { versions: EncryptionKeyVersion[] }): KeyConfig {
  return {
    key: key.key,
    name: key.name,
    activeVersion: key.activeVersion,
    versions: Object.fromEntries(
      key.versions.map((v) => [
        v.version,
        { source: { type: "env" as const, name: v.sourceName } },
      ]),
    ),
  };
}
export function connectorState(
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
/** UI and IaC share mutations. IaC ownership is metadata, not an edit lock. Historical bindings cannot be rewritten or reused. */
export async function mutateKey(
  tx: Tx,
  value: unknown,
  id: string | undefined,
  expected: number | null,
  actor: ConnectorActor,
) {
  const config = encryptionKeyConfig.parse(value);
  const current = id
    ? await tx.encryptionKey.findUniqueOrThrow({ where: { id }, include: { versions: true } })
    : null;
  checkVersion(current, expected);
  if (current && current.key !== config.key)
    throw new ConnectorError("immutable_identity", "Key identity cannot change.", 409);
  if (current?.versions.some((v) => config.versions[v.version]?.source.name !== v.sourceName))
    throw new ConnectorError(
      "immutable_version",
      "Retain every historical version and its original source binding for recovery.",
      409,
    );
  const versions = Object.entries(config.versions).map(([version, { source }]) => ({
    version,
    sourceName: source.name,
    fingerprint: sourceFingerprint(source.name),
  }));
  if (
    current?.versions.some(
      (v) => versions.find((n) => n.version === v.version)?.fingerprint !== v.fingerprint,
    )
  )
    throw new ConnectorError(
      "key_changed",
      "Restore the original material for the existing key version.",
      409,
    );
  if (current && isDeepStrictEqual(keyState(current), config)) return current;
  const row = current
    ? await tx.encryptionKey.update({
        where: { id: current.id, version: expected! },
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
  for (const version of versions.filter(
    (v) => !current?.versions.some((old) => old.version === v.version),
  ))
    await tx.encryptionKeyVersion.create({ data: { keyId: row.id, ...version } });
  await connectorAudit(tx, actor, "configuration", row.id, "key.saved");
  return row;
}
export async function mutateConnector(
  tx: Tx,
  value: unknown,
  id: string | undefined,
  expected: number | null,
  actor: ConnectorActor,
) {
  const config = connectorConfig.parse(value);
  validateScopeConfig(config);
  const current = id
    ? await tx.connector.findUniqueOrThrow({ where: { id }, include: { encryptionKey: true } })
    : null;
  checkVersion(current, expected);
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
  await encrypt(tx, key.id, "readiness", "readiness");
  if (config.enabled) {
    if (!current?.secretId)
      throw new ConnectorError(
        "missing_secret",
        "Provision the OAuth client secret before enabling the connector.",
        409,
      );
    await readSecret(tx, current.secretId, `connector:${current.id}:client-secret`);
  }
  if (current && isDeepStrictEqual(connectorState(current), config)) return current;
  const { encryptionKey: _, ...fields } = config;
  const row = current
    ? await tx.connector.update({
        where: { id: current.id, version: expected! },
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
  await connectorAudit(tx, actor, "configuration", row.id, "connector.saved");
  return row;
}
export async function setClientSecret(
  id: string,
  secret: string,
  version: number,
  actor: ConnectorActor,
) {
  if (!secret.trim() || secret.length > 10_000)
    throw new ConnectorError("invalid_secret", "A client secret is required.");
  return transaction(async (tx) => {
    const connector = await tx.connector.findUniqueOrThrow({ where: { id } });
    checkVersion(connector, version);
    const encrypted = await saveSecret(
      tx,
      connector.encryptionKeyId,
      `connector:${id}:client-secret`,
      secret,
      connector.secretId,
    );
    await tx.connector.update({
      where: { id, version },
      data: { secretId: encrypted.id, version: { increment: 1 }, updatedBy: actor.id },
    });
    await connectorAudit(tx, actor, "configuration", id, "secret.provisioned");
  });
}
export async function deleteConnector(tx: Tx, id: string, version: number, actor: ConnectorActor) {
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
  await connectorAudit(tx, actor, "configuration", id, "connector.deleted");
}
export async function deleteKey(tx: Tx, id: string, version: number, actor: ConnectorActor) {
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
  await connectorAudit(tx, actor, "configuration", id, "key.deleted");
}
/** Explicit synchronous maintenance only. Serializable conflicts roll back every ciphertext write; no provider I/O here. */
export async function reencryptConnector(id: string, version: number, actor: ConnectorActor) {
  return transaction(async (tx) => {
    const connector = await tx.connector.findUniqueOrThrow({ where: { id } });
    checkVersion(connector, version);
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
      const plaintext = await decrypt(tx, value, value.context);
      await tx.encryptedValue.update({
        where: { id: value.id, version: value.version },
        data: {
          ...(await encrypt(tx, connector.encryptionKeyId, plaintext, value.context)),
          version: { increment: 1 },
        },
      });
    }
    await connectorAudit(tx, actor, "configuration", id, "connector.reencrypted");
    return { count: values.length };
  });
}
export async function listConfiguration() {
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
    keys: keys.map((key) => ({
      id: key.id,
      version: key.version,
      config: keyState(key),
      managed: Boolean(key.iacBinding),
      available: key.versions.every((v) => {
        try {
          return sourceFingerprint(v.sourceName) === v.fingerprint;
        } catch {
          return false;
        }
      }),
    })),
    connectors: connectors.map((row) => ({
      id: row.id,
      version: row.version,
      config: connectorState(row),
      managed: Boolean(row.iacBinding),
      secretConfigured: Boolean(row.secretId),
    })),
  };
}
