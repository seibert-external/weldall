import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db, isMachineOnlySystemScope, type Prisma } from "@weldall/db";
import { z } from "zod";
import { mcpConnectorKeySchema } from "@weldall/sdk/mcp";
import { hasEffectiveSystemScopeFor } from "../../policy/resources";
import {
  sharedConnectionConfigSchema,
  publicSharedConnection,
  sharedSelectionSchema,
} from "../../domain/secret-primitive-contracts";
import { ConnectorError, type ConnectorActor } from "../contracts";
import { runConnectorTransaction } from "../configuration";
import { getConnectorProvider } from "../registry";
import { prepareSecretEnvelope, persistSecretEnvelope } from "../encryption";
import { serviceGrantSchema, apiKeySchema } from "../providers/atlassian-mcp/static";
import { ATLASSIAN_MCP } from "../providers/atlassian-mcp/config";
import { writeConnectorAuditLog } from "../audit";

export const sharedUseScopesSchema = sharedConnectionConfigSchema.shape.useScopes;
export const createSharedConnectionSchema = z.strictObject({
  connectorId: z.string().min(1).max(160),
  key: mcpConnectorKeySchema,
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  useScopeKeys: sharedUseScopesSchema,
  providerInput: sharedSelectionSchema.extend({ apiKey: apiKeySchema.optional() }),
});
export const sharedVersionSchema = z.strictObject({
  id: z.string().min(1).max(160),
  version: z.number().int().positive(),
});
export const sharedEnabledSchema = sharedVersionSchema.extend({ enabled: z.boolean() });
export const updateSharedAccessSchema = sharedVersionSchema.extend({
  useScopeKeys: sharedUseScopesSchema,
});
export const rotateSharedCredentialSchema = sharedVersionSchema.extend({
  providerInput: z.unknown(),
});

async function assertAdmin(actor: ConnectorActor, tx: Prisma.TransactionClient = db) {
  if (actor.type === "machine")
    throw new ConnectorError("forbidden", "Administrator required.", 403);
  const user = await tx.user.findUnique({ where: { id: actor.id }, select: { email: true } });
  if (!user || !(await hasEffectiveSystemScopeFor(user.email, "weldall:administer", tx)))
    throw new ConnectorError("forbidden", "Administrator required.", 403);
  return user;
}
async function resolveScopes(tx: Prisma.TransactionClient, keys: readonly string[]) {
  const scopes = await tx.scope.findMany({
    where: { key: { in: [...keys] }, isSystem: false },
    select: { id: true },
  });
  if (!keys.length || keys.some(isMachineOnlySystemScope) || scopes.length !== keys.length)
    throw new ConnectorError("invalid_scope", "Choose at least one existing non-system use scope.");
  return scopes.map(({ id }) => ({ scopeId: id }));
}
const json = (value: object) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const conflict = () =>
  new ConnectorError("conflict", "Connection changed. Reload before editing.", 409);
export const sharedConfigInclude = {
  connector: true,
  owner: { select: { email: true } },
  useScopes: { include: { scope: { select: { key: true } } } },
} as const;

/** Public mutation shared by authorized UI and IaC entrypoints; never reads or writes a secret. */
export async function saveSharedConnectionConfiguration(input: {
  tx: Prisma.TransactionClient;
  value: unknown;
  id?: string;
  createId?: string;
  expectedVersion: number | null;
  actor: ConnectorActor;
}) {
  const { tx, actor } = input;
  const config = sharedConnectionConfigSchema.parse(input.value);
  const current = input.id
    ? await tx.connection.findUnique({ where: { id: input.id }, include: sharedConfigInclude })
    : null;
  if ((current?.version ?? null) !== input.expectedVersion) throw conflict();
  if (!current && (await tx.connection.findUnique({ where: { key: config.key } })))
    throw new ConnectorError("key_exists", "Shared connection key already exists.", 409);
  if (
    current &&
    (current.accessMode !== "SCOPED" ||
      current.key !== config.key ||
      current.connector.key !== config.connectorKey)
  )
    throw new ConnectorError(
      "immutable_identity",
      "Shared connection key, connector and access mode cannot change.",
      409,
    );
  const connector = await tx.connector.findUnique({ where: { key: config.connectorKey } });
  if (!connector || connector.providerType !== "atlassian-mcp")
    throw new ConnectorError("invalid_connector", "Choose an Atlassian MCP connector.");
  const provider = getConnectorProvider(connector.providerType);
  provider.parseConfiguration(connector.providerConfig);
  provider.validateSetupInput({ config: connector.providerConfig, value: config.provider });
  const owner = await tx.user.findUnique({
    where: { email: config.credentialManagerEmail },
    select: { id: true },
  });
  if (!owner)
    throw new ConnectorError("unknown_custodian", "Credential manager must be an existing user.");
  if (current && current.ownerId !== owner.id)
    throw new ConnectorError(
      "immutable_custodian",
      "Import preserves the credential manager; reassignment is not supported.",
      409,
    );
  if (current?.credentialId && !isDeepStrictEqual(current.providerSelection, config.provider))
    throw new ConnectorError(
      "credential_binding",
      "Provision a new connection for a different account selection.",
      409,
    );
  if (config.enabled && !current?.credentialId)
    throw new ConnectorError(
      "MISSING_CREDENTIAL",
      "Create disabled and provision the credential in the admin UI.",
      409,
    );
  if (config.enabled && current) provider.parseGrant(current.providerGrant);
  const scopes = await resolveScopes(tx, config.useScopes);
  // IaC may temporarily stage empty scope links inside its replacement transaction.
  if (current?.useScopes.length && isDeepStrictEqual(publicSharedConnection(current), config))
    return current;
  const data = {
    name: config.name,
    accountName: config.serviceAccountLabel,
    enabled: config.enabled,
    providerSelection: json(config.provider),
    useScopes: { create: scopes },
  };
  const row = current
    ? await tx.connection.update({
        where: { id: current.id, version: current.version },
        data: {
          ...data,
          useScopes: { deleteMany: {}, create: scopes },
          version: { increment: 1 },
        },
      })
    : await tx.connection.create({
        data: {
          ...data,
          id: input.createId ?? randomUUID(),
          key: config.key,
          accessMode: "SCOPED",
          ownerId: owner.id,
          connectorId: connector.id,
          accountId: config.key,
          providerGrant: {},
        },
      });
  await writeConnectorAuditLog({
    tx,
    actor,
    event: "lifecycle",
    subjectId: row.id,
    operation: !current
      ? "connection.shared.created"
      : current.enabled !== config.enabled
        ? config.enabled
          ? "connection.shared.enabled"
          : "connection.shared.disabled"
        : "connection.shared.access_updated",
    details: { connectorId: connector.id },
  });
  return row;
}

export async function createSharedConnection(value: unknown, actor: ConnectorActor) {
  const user = await assertAdmin(actor);
  const input = createSharedConnectionSchema.parse(value);
  const connector = await db.connector.findUnique({ where: { id: input.connectorId } });
  if (!connector || connector.providerType !== "atlassian-mcp")
    throw new ConnectorError("invalid_connector", "Choose an Atlassian MCP connector.");
  const { apiKey, ...selection } = input.providerInput;
  if (input.enabled && !apiKey)
    throw new ConnectorError(
      "MISSING_CREDENTIAL",
      "A credential is required to enable the connection.",
    );
  const id = randomUUID();
  const envelope = apiKey
    ? await prepareSecretEnvelope({
        provider: connector.envelopeProvider,
        connectorId: connector.id,
        context: `connection:${id}:credentials`,
        plaintext: JSON.stringify({ kind: selection.kind, apiKey }),
      })
    : null;
  return runConnectorTransaction(async (tx) => {
    await assertAdmin(actor, tx);
    const latest = await tx.connector.findUnique({ where: { id: connector.id } });
    if (!latest || latest.version !== connector.version) throw conflict();
    // Use the public core for all validation. A create with credentials is still one atomic UI operation.
    await saveSharedConnectionConfiguration({
      tx,
      actor,
      createId: id,
      expectedVersion: null,
      value: {
        key: input.key,
        name: input.name,
        connectorKey: connector.key,
        enabled: false,
        credentialManagerEmail: user.email,
        serviceAccountLabel: input.name,
        useScopes: input.useScopeKeys,
        provider: selection,
      },
    });
    if (envelope) {
      const credential = await persistSecretEnvelope({ tx, envelope });
      await tx.connection.update({
        where: { id },
        data: {
          credentialId: credential.id,
          enabled: input.enabled,
          providerGrant: json(
            serviceGrantSchema.parse({ ...selection, resource: ATLASSIAN_MCP.resource }),
          ),
        },
      });
    }
    return { id };
  });
}
async function sharedRow(
  tx: Prisma.TransactionClient,
  input: z.output<typeof sharedVersionSchema>,
) {
  const row = await tx.connection.findUnique({
    where: { id: input.id },
    include: sharedConfigInclude,
  });
  if (!row || row.accessMode !== "SCOPED")
    throw new ConnectorError("not_found", "Shared connection not found.", 404);
  if (row.version !== input.version) throw conflict();
  return row;
}
export async function updateSharedConnectionAccess(value: unknown, actor: ConnectorActor) {
  await assertAdmin(actor);
  const input = updateSharedAccessSchema.parse(value);
  return runConnectorTransaction(async (tx) => {
    await assertAdmin(actor, tx);
    const row = await sharedRow(tx, input);
    await saveSharedConnectionConfiguration({
      tx,
      actor,
      id: row.id,
      expectedVersion: row.version,
      value: { ...publicSharedConnection(row), useScopes: input.useScopeKeys },
    });
  });
}
export async function rotateSharedConnectionCredential(value: unknown, actor: ConnectorActor) {
  await assertAdmin(actor);
  const input = rotateSharedCredentialSchema.parse(value);
  const row = await sharedRow(db, input);
  const provider = getConnectorProvider(row.connector.providerType);
  if (!provider.staticConnection || row.connector.providerType !== "atlassian-mcp")
    throw conflict();
  provider.validateSetupInput({
    config: row.connector.providerConfig,
    value: row.providerSelection,
  });
  const credentials = provider.staticConnection.parseRotateInput(input.providerInput);
  const grant = serviceGrantSchema.parse({
    ...sharedSelectionSchema.parse(row.providerSelection),
    resource: ATLASSIAN_MCP.resource,
  });
  await provider.ensureGrantCurrent({
    config: row.connector.providerConfig,
    selection: row.providerSelection,
    credentials,
    previousGrant: provider.parseGrant(grant),
  });
  const envelope = await prepareSecretEnvelope({
    provider: row.connector.envelopeProvider,
    connectorId: row.connectorId,
    context: `connection:${row.id}:credentials`,
    plaintext: JSON.stringify(credentials),
  });
  return runConnectorTransaction(async (tx) => {
    await assertAdmin(actor, tx);
    const current = await sharedRow(tx, input);
    if (
      current.connector.version !== row.connector.version ||
      current.credentialId !== row.credentialId
    )
      throw conflict();
    if (!["READY", "RECONNECT_REQUIRED"].includes(current.status)) throw conflict();
    const credential = await persistSecretEnvelope({ tx, envelope, id: row.credentialId });
    await tx.connection.update({
      where: { id: row.id, version: row.version },
      data: {
        credentialId: credential.id,
        providerGrant: json(grant),
        status: "READY",
        version: { increment: 1 },
      },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: row.id,
      operation: "connection.shared.credential_rotated",
    });
  });
}
export async function setSharedConnectionEnabled(value: unknown, actor: ConnectorActor) {
  await assertAdmin(actor);
  const input = sharedEnabledSchema.parse(value);
  return runConnectorTransaction(async (tx) => {
    await assertAdmin(actor, tx);
    const row = await sharedRow(tx, input);
    await saveSharedConnectionConfiguration({
      tx,
      actor,
      id: row.id,
      expectedVersion: row.version,
      value: { ...publicSharedConnection(row), enabled: input.enabled },
    });
  });
}
