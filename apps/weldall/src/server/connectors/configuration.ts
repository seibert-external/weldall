import { isDeepStrictEqual } from "node:util";
import { db, Prisma, type Connector } from "@weldall/db";
import { seal, unseal } from "../auth/oidc-credentials";
import {
  connectorConfig,
  ConnectorError,
  type ConnectorActor,
  type ConnectorConfig,
} from "./contracts";
import { validateConnectorScopeConfig } from "./scopes";
import { encrypt } from "./encryption";
import { writeConnectorAuditLog } from "./audit";

type Tx = Prisma.TransactionClient;

/** Runs lifecycle writes with serializable compare-and-set semantics. */
export const runConnectorTransaction = <T>(operation: (tx: Tx) => Promise<T>) =>
  db.$transaction(operation, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 15_000,
  });

/** Ensures UI and IaC writes use the latest configuration revision. */
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

/** Explicit allowlist keeps the fixed-encrypted, write-only client secret out of UI and IaC. */
export function buildConnectorState(row: Connector): ConnectorConfig {
  return connectorConfig.parse({
    key: row.key,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    envelopeProvider: row.envelopeProvider,
    clientId: row.clientId,
    enabledApis: row.enabledApis,
    allowedScopes: row.allowedScopes,
    defaultScopes: row.defaultScopes,
  });
}

/** Reads fixed application encryption, never the connector envelope provider. */
export function readConnectorClientSecret(connector: Connector): string {
  if (!connector.encryptedClientSecret)
    throw new ConnectorError("unavailable", "Connector is not configured.", 503);
  try {
    return unseal("connector-client-secret", connector.id, connector.encryptedClientSecret);
  } catch {
    throw new ConnectorError(
      "credential_unavailable",
      "Connector client secret is unavailable.",
      503,
    );
  }
}

/** Shared UI/IaC write path: identity and envelope provider cannot change after creation. */
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
  const current = id ? await tx.connector.findUniqueOrThrow({ where: { id } }) : null;
  assertConfigurationVersion({ current, expected: expectedVersion });
  if (current && current.key !== config.key)
    throw new ConnectorError("immutable_identity", "Connector identity cannot change.", 409);
  if (current && current.envelopeProvider !== config.envelopeProvider)
    throw new ConnectorError(
      "immutable_provider",
      "Connector envelope provider cannot change.",
      409,
    );
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
  // Disabled definitions also require provisioned deployment material, without persisting a probe.
  await encrypt({
    provider: config.envelopeProvider,
    plaintext: "readiness",
    context: "readiness",
  });
  if (config.enabled) {
    if (!current?.encryptedClientSecret)
      throw new ConnectorError(
        "missing_secret",
        "Provision the OAuth client secret before enabling the connector.",
        409,
      );
    readConnectorClientSecret(current);
  }
  if (current && isDeepStrictEqual(buildConnectorState(current), config)) return current;
  const row = current
    ? await tx.connector.update({
        where: { id: current.id, version: expectedVersion! },
        data: {
          ...config,
          ...(clientIdChanged ? { encryptedClientSecret: null } : {}),
          version: { increment: 1 },
          updatedBy: actor.id,
        },
      })
    : await tx.connector.create({ data: { ...config, createdBy: actor.id, updatedBy: actor.id } });
  await writeConnectorAuditLog({
    tx,
    actor,
    event: "configuration",
    subjectId: row.id,
    operation: "connector.saved",
  });
  return row;
}

/** Replaces only the fixed-encrypted OAuth client secret; provider credentials are separate. */
export async function saveConnectorClientSecret({
  id,
  secret,
  expectedVersion,
  actor,
}: {
  id: string;
  secret: string;
  expectedVersion: number;
  actor: ConnectorActor;
}) {
  if (!secret.trim() || secret.length > 10_000)
    throw new ConnectorError("invalid_secret", "A client secret is required.");
  return runConnectorTransaction(async (tx) => {
    const connector = await tx.connector.findUniqueOrThrow({ where: { id } });
    assertConfigurationVersion({ current: connector, expected: expectedVersion });
    let encryptedClientSecret: string;
    try {
      encryptedClientSecret = seal("connector-client-secret", id, secret);
    } catch {
      throw new ConnectorError(
        "credential_unavailable",
        "Application encryption is unavailable.",
        503,
      );
    }
    await tx.connector.update({
      where: { id, version: expectedVersion },
      data: { encryptedClientSecret, version: { increment: 1 }, updatedBy: actor.id },
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

/** Deletes an unused definition, including its fixed-encrypted client secret. */
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
  await tx.connector.delete({ where: { id, version } });
  await writeConnectorAuditLog({
    tx,
    actor,
    event: "configuration",
    subjectId: id,
    operation: "connector.deleted",
  });
}

/** Lists only non-secret configuration and presence flags. */
export async function listManagedConnectorConfiguration() {
  const connectors = await db.connector.findMany({
    include: { iacBinding: true },
    orderBy: { key: "asc" },
  });
  return {
    connectors: connectors.map((row) => ({
      id: row.id,
      version: row.version,
      config: buildConnectorState(row),
      managed: Boolean(row.iacBinding),
      secretConfigured: Boolean(row.encryptedClientSecret),
    })),
  };
}
