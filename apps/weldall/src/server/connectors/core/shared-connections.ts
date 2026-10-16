import { randomUUID } from "node:crypto";
import { db, isMachineOnlySystemScope, type Prisma } from "@weldall/db";
import { z } from "zod";
import { mcpConnectorKeySchema } from "@weldall/sdk/mcp";
import { hasEffectiveSystemScopeFor } from "../../policy/resources";
import { scopeKeySchema } from "../../policy/scope-key";
import { ConnectorError, type ConnectorActor } from "../contracts";
import { runConnectorTransaction } from "../configuration";
import { getConnectorProvider } from "../registry";
import { prepareSecretEnvelope, persistSecretEnvelope } from "../encryption";
import { writeConnectorAuditLog } from "../audit";

export const sharedUseScopesSchema = z
  .array(scopeKeySchema)
  .min(1)
  .max(100)
  .transform((keys) => [...new Set(keys)].sort());
export const createSharedConnectionSchema = z.strictObject({
  connectorId: z.string().min(1).max(160),
  key: mcpConnectorKeySchema,
  name: z.string().trim().min(1).max(200),
  useScopeKeys: sharedUseScopesSchema,
  providerInput: z.unknown(),
});
export const sharedVersionSchema = z.strictObject({
  id: z.string().min(1).max(160),
  version: z.number().int().positive(),
});
export const sharedEnabledSchema = sharedVersionSchema.extend({
  enabled: z.boolean(),
});
export const updateSharedAccessSchema = sharedVersionSchema.extend({
  useScopeKeys: sharedUseScopesSchema,
});
export const rotateSharedCredentialSchema = sharedVersionSchema.extend({
  providerInput: z.unknown(),
});

async function assertAdmin(actor: ConnectorActor) {
  if (actor.type === "machine")
    throw new ConnectorError("forbidden", "Administrator required.", 403);
  const user = await db.user.findUnique({ where: { id: actor.id }, select: { email: true } });
  if (!user || !(await hasEffectiveSystemScopeFor(user.email, "weldall:administer")))
    throw new ConnectorError("forbidden", "Administrator required.", 403);
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

export async function createSharedConnection(value: unknown, actor: ConnectorActor) {
  await assertAdmin(actor);
  const input = createSharedConnectionSchema.parse(value);
  const connector = await db.connector.findUnique({ where: { id: input.connectorId } });
  if (!connector?.enabled || connector.providerType !== "atlassian-mcp")
    throw new ConnectorError("invalid_connector", "Choose an enabled Atlassian MCP connector.");
  const provider = getConnectorProvider(connector.providerType);
  if (!provider.staticConnection)
    throw new ConnectorError("invalid_connector", "Static credentials are not supported.");
  const parsed = provider.staticConnection.parseCreateInput(input.providerInput);
  provider.validateSetupInput({ config: connector.providerConfig, value: parsed.selection });
  const id = randomUUID();
  const envelope = await prepareSecretEnvelope({
    provider: connector.envelopeProvider,
    connectorId: connector.id,
    context: `connection:${id}:credentials`,
    plaintext: JSON.stringify(parsed.credentials),
  });
  return runConnectorTransaction(async (tx) => {
    const current = await tx.connector.findUnique({ where: { id: connector.id } });
    if (!current?.enabled || current.version !== connector.version) throw conflict();
    if (await tx.connection.findUnique({ where: { key: input.key } }))
      throw new ConnectorError("key_exists", "Shared connection key already exists.", 409);
    const scopes = await resolveScopes(tx, input.useScopeKeys);
    const credential = await persistSecretEnvelope({ tx, envelope });
    await tx.connection.create({
      data: {
        id,
        ownerId: actor.id,
        connectorId: connector.id,
        key: input.key,
        accessMode: "SCOPED",
        name: input.name,
        accountId: input.key,
        accountName: input.name,
        providerSelection: json(parsed.selection),
        providerGrant: json(parsed.grant),
        credentialId: credential.id,
        useScopes: { create: scopes },
      },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: id,
      operation: "connection.shared.created",
      details: { connectorId: connector.id },
    });
    return { id };
  });
}

async function sharedRow(
  tx: Prisma.TransactionClient,
  input: z.output<typeof sharedVersionSchema>,
) {
  const row = await tx.connection.findUnique({
    where: { id: input.id },
    include: { connector: true },
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
    await sharedRow(tx, input);
    const scopes = await resolveScopes(tx, input.useScopeKeys);
    await tx.connection.update({
      where: { id: input.id, version: input.version },
      data: {
        useScopes: { deleteMany: {}, create: scopes },
        version: { increment: 1 },
      },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: input.id,
      operation: "connection.shared.access_updated",
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
  await provider.ensureGrantCurrent({
    config: row.connector.providerConfig,
    selection: row.providerSelection,
    credentials,
    previousGrant: provider.parseGrant(row.providerGrant),
  });
  const envelope = await prepareSecretEnvelope({
    provider: row.connector.envelopeProvider,
    connectorId: row.connectorId,
    context: `connection:${row.id}:credentials`,
    plaintext: JSON.stringify(credentials),
  });
  return runConnectorTransaction(async (tx) => {
    const current = await sharedRow(tx, input);
    if (
      current.connector.version !== row.connector.version ||
      current.credentialId !== row.credentialId
    )
      throw conflict();
    const credential = await persistSecretEnvelope({ tx, envelope, id: row.credentialId });
    await tx.connection.update({
      where: { id: row.id, version: row.version },
      data: { credentialId: credential.id, version: { increment: 1 } },
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
    const row = await sharedRow(tx, input);
    if (row.status !== (input.enabled ? "DISABLED" : "READY") || !row.credentialId)
      throw conflict();
    await tx.connection.update({
      where: { id: input.id, version: input.version },
      data: { status: input.enabled ? "READY" : "DISABLED", version: { increment: 1 } },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: input.id,
      operation: input.enabled ? "connection.shared.enabled" : "connection.shared.disabled",
    });
  });
}
