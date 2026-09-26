import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db, Prisma, type Connector } from "@weldall/db";
import { seal, unseal } from "../auth/oidc-credentials";
import {
  connectorConfig,
  ConnectorError,
  type ConnectorActor,
  type ConnectorConfig,
} from "./contracts";
import { getConnectorProvider } from "./registry";
import { encrypt } from "./encryption";
import { writeConnectorAuditLog } from "./audit";
import { connectorRequiredScopeKeys, connectorScopeInclude } from "./access";

type Tx = Prisma.TransactionClient;
type ConnectorWithRequiredScopes = Connector & {
  requiredScopes: { scope: { key: string } }[];
};

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
export function buildConnectorState(row: ConnectorWithRequiredScopes): ConnectorConfig {
  return connectorConfig.parse({
    key: row.key,
    name: row.name,
    type: row.providerType,
    enabled: row.enabled,
    envelopeProvider: row.envelopeProvider,
    requiredScopes: connectorRequiredScopeKeys(row),
    provider: getConnectorProvider(row.providerType).parseConfiguration(row.providerConfig),
  });
}

/** Resolves required scope keys to stable relational identifiers without accepting unknown scopes. */
async function resolveRequiredScopes({
  tx,
  scopeKeys,
}: {
  tx: Tx;
  scopeKeys: string[];
}): Promise<{ id: string; key: string }[]> {
  const scopes = scopeKeys.length
    ? await tx.scope.findMany({
        where: { key: { in: scopeKeys } },
        select: { id: true, key: true },
      })
    : [];
  if (scopes.length !== scopeKeys.length)
    throw new ConnectorError("invalid_scope", "One or more required scopes do not exist.");
  return scopes.sort((left, right) => left.key.localeCompare(right.key));
}

/** Reads fixed application encryption, never the connector envelope provider. */
export function readConnectorSecrets(connector: Connector) {
  const provider = getConnectorProvider(connector.providerType);
  if (!connector.encryptedProviderSecrets)
    throw new ConnectorError("unavailable", "Connector is not configured.", 503);
  try {
    return provider.parseSecrets(
      JSON.parse(
        unseal("connector-provider-secrets", connector.id, connector.encryptedProviderSecrets),
      ),
    );
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
  providerSecrets,
}: {
  tx: Tx;
  value: unknown;
  id: string | undefined;
  expectedVersion: number | null;
  actor: ConnectorActor;
  /** Write-only UI input, deliberately separate from the declarative configuration. */
  providerSecrets?: unknown;
}) {
  const config = connectorConfig.parse(value);
  const provider = getConnectorProvider(config.type);
  const providerConfig = provider.parseConfiguration(config.provider);
  const requiredScopes = await resolveRequiredScopes({ tx, scopeKeys: config.requiredScopes });
  const current = id
    ? await tx.connector.findUniqueOrThrow({ where: { id }, include: connectorScopeInclude })
    : null;
  assertConfigurationVersion({ current, expected: expectedVersion });
  if (current && current.key !== config.key)
    throw new ConnectorError("immutable_identity", "Connector identity cannot change.", 409);
  if (current && current.envelopeProvider !== config.envelopeProvider)
    throw new ConnectorError(
      "immutable_provider",
      "Connector envelope provider cannot change.",
      409,
    );
  if (current && current.providerType !== config.type)
    throw new ConnectorError("immutable_provider", "Connector provider type cannot change.", 409);
  const clientIdChanged = Boolean(
    current &&
    provider.configurationIdentity(current.providerConfig) !==
      provider.configurationIdentity(providerConfig),
  );
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
  if (clientIdChanged && config.enabled && providerSecrets === undefined)
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
  const connectorId = current?.id ?? randomUUID();
  const encryptedProviderSecrets =
    providerSecrets !== undefined
      ? encryptProviderSecrets({ id: connectorId, secrets: provider.parseSecrets(providerSecrets) })
      : clientIdChanged
        ? null
        : (current?.encryptedProviderSecrets ?? null);
  if (config.enabled) {
    if (!encryptedProviderSecrets)
      throw new ConnectorError(
        "missing_secret",
        "Provision the OAuth client secret before enabling the connector.",
        409,
      );
    if (providerSecrets === undefined && current) readConnectorSecrets(current);
  }
  if (
    current &&
    providerSecrets === undefined &&
    isDeepStrictEqual(buildConnectorState(current), config)
  )
    return current;
  const { type, provider: _provider, requiredScopes: _requiredScopes, ...coreConfig } = config;
  const data = { ...coreConfig, providerType: type, providerConfig, encryptedProviderSecrets };
  const row = current
    ? await tx.connector.update({
        where: { id: current.id, version: expectedVersion! },
        data: {
          ...data,
          requiredScopes: {
            deleteMany: {},
            create: requiredScopes.map(({ id: scopeId }) => ({ scopeId })),
          },
          version: { increment: 1 },
          updatedBy: actor.id,
        },
        include: connectorScopeInclude,
      })
    : await tx.connector.create({
        data: {
          ...data,
          id: connectorId,
          createdBy: actor.id,
          updatedBy: actor.id,
          requiredScopes: {
            create: requiredScopes.map(({ id: scopeId }) => ({ scopeId })),
          },
        },
        include: connectorScopeInclude,
      });
  await writeConnectorAuditLog({
    tx,
    actor,
    event: "configuration",
    subjectId: row.id,
    operation: "connector.saved",
  });
  if (providerSecrets !== undefined)
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "configuration",
      subjectId: row.id,
      operation: "secret.provisioned",
    });
  return row;
}

function encryptProviderSecrets({ id, secrets }: { id: string; secrets: object }): string {
  try {
    return seal("connector-provider-secrets", id, JSON.stringify(secrets));
  } catch {
    throw new ConnectorError(
      "credential_unavailable",
      "Application encryption is unavailable.",
      503,
    );
  }
}

/** Replaces only the fixed-encrypted OAuth client secret; provider credentials are separate. */
export async function saveConnectorSecrets({
  id,
  secrets,
  expectedVersion,
  actor,
}: {
  id: string;
  secrets: unknown;
  expectedVersion: number;
  actor: ConnectorActor;
}) {
  return runConnectorTransaction(async (tx) => {
    const connector = await tx.connector.findUniqueOrThrow({ where: { id } });
    assertConfigurationVersion({ current: connector, expected: expectedVersion });
    const encryptedProviderSecrets = encryptProviderSecrets({
      id,
      secrets: getConnectorProvider(connector.providerType).parseSecrets(secrets),
    });
    await tx.connector.update({
      where: { id, version: expectedVersion },
      data: { encryptedProviderSecrets, version: { increment: 1 }, updatedBy: actor.id },
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
    include: { iacBinding: true, ...connectorScopeInclude },
    orderBy: { key: "asc" },
  });
  return {
    connectors: connectors.map((row) => ({
      id: row.id,
      version: row.version,
      config: buildConnectorState(row),
      managed: Boolean(row.iacBinding),
      secretConfigured: Boolean(row.encryptedProviderSecrets),
    })),
  };
}
