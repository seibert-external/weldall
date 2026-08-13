import { db, Prisma } from "@weldall/db";
import { assertPublicP256 } from "@weldall/sdk";
import { calculateJwkThumbprint, type JWK } from "jose";
import { AdminDomainError, type AdminActor, type ManagementDto } from "../admin/service";
import { prismaAuditWriter } from "../audit/service";

const clientIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const kidPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const include = {
  keys: { orderBy: [{ createdAt: "desc" as const }, { kid: "asc" as const }] },
  allowedResources: {
    include: {
      resource: { select: { id: true, key: true, name: true, resourceIdentifier: true } },
    },
  },
  allowedScopes: { include: { scope: { select: { id: true, key: true } } } },
} satisfies Prisma.MachineClientInclude;

type MachineWithRelations = Prisma.MachineClientGetPayload<{ include: typeof include }>;
type MachineAccessInput = { resourceIds: string[]; scopeIds: string[] };

export interface MachineClientDto {
  id: string;
  clientId: string;
  name: string;
  enabled: boolean;
  deactivatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  management: ManagementDto;
  keys: Array<{
    id: string;
    kid: string;
    publicJwk: JWK;
    thumbprint: string;
    revokedAt: string | null;
    createdAt: string;
  }>;
  access: {
    resourceIds: string[];
    resources: Array<{
      id: string;
      key: string;
      name: string;
      resourceIdentifier: string;
    }>;
    scopeIds: string[];
    scopeKeys: string[];
  };
}

export async function listMachineClients(): Promise<MachineClientDto[]> {
  return (await db.machineClient.findMany({ orderBy: { name: "asc" }, include })).map(serialize);
}

export async function getMachineClient(id: string): Promise<MachineClientDto> {
  const client = await db.machineClient.findUnique({ where: { id }, include });
  if (!client) throw new AdminDomainError("NOT_FOUND", "Machine client not found.");
  return serialize(client);
}

export async function listMachineAccessOptions(): Promise<{
  resources: Array<{
    id: string;
    name: string;
    resourceIdentifier: string;
    enabled: boolean;
  }>;
  scopes: Array<{ id: string; key: string }>;
}> {
  const [resources, scopes] = await Promise.all([
    db.downstreamResource.findMany({
      orderBy: [{ name: "asc" }, { key: "asc" }],
      select: { id: true, name: true, resourceIdentifier: true, enabled: true },
    }),
    db.scope.findMany({ orderBy: { key: "asc" }, select: { id: true, key: true } }),
  ]);
  return { resources, scopes };
}

export async function createMachineClient(
  input: {
    clientId: string;
    name: string;
    key: { kid: string; publicJwk: unknown };
    access: MachineAccessInput;
  },
  actor: AdminActor,
): Promise<MachineClientDto> {
  const clientId = parseClientId(input.clientId);
  const name = parseName(input.name);
  const key = await parseKey(input.key);
  validateAccessShape(input.access);
  try {
    return await db.$transaction(async (tx) => {
      await lockResourceChanges(tx);
      const access = await validateAccess(input.access, tx);
      const client = await tx.machineClient.create({
        data: {
          clientId,
          name,
          createdBy: actor.id,
          updatedBy: actor.id,
          keys: {
            create: {
              kid: key.kid,
              publicJwk: key.publicJwk as Prisma.InputJsonObject,
              thumbprint: key.thumbprint,
              createdBy: actor.id,
            },
          },
          allowedResources: {
            create: access.resourceIds.map((resourceId) => ({ resourceId })),
          },
          allowedScopes: { create: access.scopeIds.map((scopeId) => ({ scopeId })) },
        },
        include,
      });
      await prismaAuditWriter.write(
        {
          eventType: "machine_client.created",
          actorType: "user",
          actorId: actor.id,
          ...(actor.email ? { actorEmail: actor.email } : {}),
          requestId: actor.requestId,
          ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
          outcome: "success",
          subjectType: "machine_client",
          subjectId: client.id,
          metadata: clientMetadata(client),
        },
        tx,
      );
      await prismaAuditWriter.write(
        keyAudit("machine_key.registered", client, client.keys[0]!, actor),
        tx,
      );
      await prismaAuditWriter.write(accessAudit(client, emptyAccess(), 0, actor), tx);
      return serialize(client);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new AdminDomainError("CONFLICT", "Client ID, key ID, or key is already registered.");
    throw error;
  }
}

export async function updateMachineClient(
  input: { id: string; name: string; enabled: boolean; expectedVersion: number },
  actor: AdminActor,
): Promise<MachineClientDto> {
  const name = parseName(input.name);
  return db.$transaction(async (tx) => {
    const current = await tx.machineClient.findUnique({ where: { id: input.id } });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Machine client not found.");
    if (current.version !== input.expectedVersion)
      throw new AdminDomainError("CONFLICT", "The machine client changed. Reload and try again.");
    const changed = await tx.machineClient.updateMany({
      where: { id: input.id, version: input.expectedVersion },
      data: {
        name,
        enabled: input.enabled,
        deactivatedAt: input.enabled ? null : (current.deactivatedAt ?? new Date()),
        updatedBy: actor.id,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1)
      throw new AdminDomainError("CONFLICT", "The machine client changed. Reload and try again.");
    const client = await tx.machineClient.findUniqueOrThrow({ where: { id: input.id }, include });
    await prismaAuditWriter.write(
      {
        eventType: input.enabled ? "machine_client.updated" : "machine_client.deactivated",
        actorType: "user",
        actorId: actor.id,
        ...(actor.email ? { actorEmail: actor.email } : {}),
        requestId: actor.requestId,
        ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
        outcome: "success",
        subjectType: "machine_client",
        subjectId: client.id,
        metadata: clientMetadata(client),
      },
      tx,
    );
    return serialize(client);
  });
}

export async function deleteMachineClient(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    const current = await tx.machineClient.findUnique({ where: { id: input.id } });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Machine client not found.");
    if (current.version !== input.expectedVersion)
      throw new AdminDomainError("CONFLICT", "The machine client changed. Reload and try again.");
    await tx.machineClient.delete({ where: { id: current.id } });
    await prismaAuditWriter.write(
      {
        eventType: "machine_client.deleted",
        actorType: "user",
        actorId: actor.id,
        ...(actor.email ? { actorEmail: actor.email } : {}),
        requestId: actor.requestId,
        ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
        outcome: "success",
        subjectType: "machine_client",
        subjectId: current.id,
        metadata: clientMetadata(current),
      },
      tx,
    );
    return { id: current.id };
  });
}

export async function registerMachineKey(
  input: { clientId: string; kid: string; publicJwk: unknown },
  actor: AdminActor,
): Promise<MachineClientDto> {
  const key = await parseKey(input);
  try {
    return await db.$transaction(async (tx) => {
      const client = await tx.machineClient.findUnique({ where: { id: input.clientId } });
      if (!client) throw new AdminDomainError("NOT_FOUND", "Machine client not found.");
      const created = await tx.machineClientKey.create({
        data: {
          machineClientId: client.id,
          kid: key.kid,
          publicJwk: key.publicJwk as Prisma.InputJsonObject,
          thumbprint: key.thumbprint,
          createdBy: actor.id,
        },
      });
      await prismaAuditWriter.write(keyAudit("machine_key.registered", client, created, actor), tx);
      return serialize(
        await tx.machineClient.findUniqueOrThrow({ where: { id: client.id }, include }),
      );
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new AdminDomainError("CONFLICT", "This key ID or public key is already registered.");
    throw error;
  }
}

export async function revokeMachineKey(
  input: { clientId: string; keyId: string },
  actor: AdminActor,
): Promise<MachineClientDto> {
  return db.$transaction(async (tx) => {
    const [client, key] = await Promise.all([
      tx.machineClient.findUnique({ where: { id: input.clientId } }),
      tx.machineClientKey.findUnique({ where: { id: input.keyId } }),
    ]);
    if (!client || !key || key.machineClientId !== client.id)
      throw new AdminDomainError("NOT_FOUND", "Machine key not found.");
    const revoked = key.revokedAt
      ? key
      : await tx.machineClientKey.update({
          where: { id: key.id },
          data: { revokedAt: new Date(), revokedBy: actor.id },
        });
    if (!key.revokedAt)
      await prismaAuditWriter.write(keyAudit("machine_key.revoked", client, revoked, actor), tx);
    return serialize(
      await tx.machineClient.findUniqueOrThrow({ where: { id: client.id }, include }),
    );
  });
}

export async function replaceMachineAccess(
  input: { clientId: string; resourceIds: string[]; scopeIds: string[]; expectedVersion: number },
  actor: AdminActor,
): Promise<MachineClientDto> {
  validateAccessShape(input);
  return db.$transaction(async (tx) => {
    await lockResourceChanges(tx);
    const current = await tx.machineClient.findUnique({ where: { id: input.clientId }, include });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Machine client not found.");
    const access = await validateAccess(
      input,
      tx,
      new Set(current.allowedResources.map(({ resourceId }) => resourceId)),
    );
    if (current.version !== input.expectedVersion)
      throw new AdminDomainError("CONFLICT", "The machine access changed. Reload and try again.");
    const before = accessSnapshot(current);
    const unchanged =
      sameStrings(before.resourceIdentifiers, access.resourceIdentifiers) &&
      sameStrings(before.scopeKeys, access.scopeKeys);
    if (unchanged) return serialize(current);

    const changed = await tx.machineClient.updateMany({
      where: { id: current.id, version: input.expectedVersion },
      data: { updatedBy: actor.id, version: { increment: 1 } },
    });
    if (changed.count !== 1)
      throw new AdminDomainError("CONFLICT", "The machine access changed. Reload and try again.");
    await tx.machineAllowedResource.deleteMany({ where: { machineClientId: current.id } });
    await tx.machineAllowedScope.deleteMany({ where: { machineClientId: current.id } });
    if (access.resourceIds.length)
      await tx.machineAllowedResource.createMany({
        data: access.resourceIds.map((resourceId) => ({
          machineClientId: current.id,
          resourceId,
        })),
      });
    if (access.scopeIds.length)
      await tx.machineAllowedScope.createMany({
        data: access.scopeIds.map((scopeId) => ({ machineClientId: current.id, scopeId })),
      });
    const client = await tx.machineClient.findUniqueOrThrow({
      where: { id: current.id },
      include,
    });
    await prismaAuditWriter.write(accessAudit(client, before, current.version, actor), tx);
    return serialize(client);
  });
}

async function parseKey(input: { kid: string; publicJwk: unknown }) {
  const kid = input.kid.trim();
  if (!kidPattern.test(kid))
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      "Key IDs may contain letters, digits, dot, underscore, colon, and dash.",
    );
  if (!input.publicJwk || typeof input.publicJwk !== "object" || Array.isArray(input.publicJwk))
    throw new AdminDomainError("INVALID_RESOURCE", "Enter a public ES256 JWK object.");
  const candidate = structuredClone(input.publicJwk) as JWK;
  if ("d" in candidate)
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      "Private JWK material must never be registered.",
    );
  try {
    await assertPublicP256(candidate);
  } catch {
    throw new AdminDomainError("INVALID_RESOURCE", "Enter a valid public ES256 P-256 JWK.");
  }
  const publicJwk: JWK = {
    kty: "EC",
    crv: "P-256",
    x: candidate.x!,
    y: candidate.y!,
    alg: "ES256",
    use: "sig",
  };
  return {
    kid,
    publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk, "sha256"),
  };
}

function validateAccessShape(access: MachineAccessInput): void {
  if (
    access.resourceIds.length > 100 ||
    new Set(access.resourceIds).size !== access.resourceIds.length
  )
    throw new AdminDomainError("INVALID_RESOURCE", "Selected resources must be unique.");
  if (access.scopeIds.length > 100 || new Set(access.scopeIds).size !== access.scopeIds.length)
    throw new AdminDomainError("INVALID_SCOPE", "Selected scopes must be unique.");
}

async function validateAccess(
  access: MachineAccessInput,
  tx: Prisma.TransactionClient,
  retainedDisabledResourceIds: ReadonlySet<string> = new Set(),
) {
  const [resources, scopes] = await Promise.all([
    tx.downstreamResource.findMany({
      where: { id: { in: access.resourceIds } },
      select: { id: true, resourceIdentifier: true, enabled: true },
    }),
    tx.scope.findMany({
      where: { id: { in: access.scopeIds } },
      select: { id: true, key: true },
    }),
  ]);
  if (resources.length !== access.resourceIds.length)
    throw new AdminDomainError("INVALID_RESOURCE", "Choose registered resources.");
  if (resources.some(({ id, enabled }) => !enabled && !retainedDisabledResourceIds.has(id)))
    throw new AdminDomainError("INVALID_RESOURCE", "Choose enabled resources.");
  if (scopes.length !== access.scopeIds.length)
    throw new AdminDomainError("INVALID_SCOPE", "Choose registered scopes.");
  return {
    resourceIds: [...access.resourceIds].sort(),
    resourceIdentifiers: resources.map(({ resourceIdentifier }) => resourceIdentifier).sort(),
    scopeIds: [...access.scopeIds].sort(),
    scopeKeys: scopes.map(({ key }) => key).sort(),
  };
}

async function lockResourceChanges(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(49350618)`;
}

function parseClientId(value: string): string {
  const clientId = value.trim();
  if (!clientIdPattern.test(clientId) || clientId === "weldall-cli")
    throw new AdminDomainError("INVALID_RESOURCE", "Enter a safe, unique machine client ID.");
  return clientId;
}

function parseName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200)
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      "Machine names must contain 1 to 200 characters.",
    );
  return name;
}

function serialize(client: MachineWithRelations): MachineClientDto {
  const resources = client.allowedResources
    .map(({ resource }) => resource)
    .sort((left, right) => left.name.localeCompare(right.name));
  const scopes = client.allowedScopes
    .map(({ scope }) => scope)
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    id: client.id,
    clientId: client.clientId,
    name: client.name,
    enabled: client.enabled,
    deactivatedAt: client.deactivatedAt?.toISOString() ?? null,
    version: client.version,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
    management: { type: "manual" },
    keys: client.keys.map((key) => ({
      id: key.id,
      kid: key.kid,
      publicJwk: key.publicJwk as JWK,
      thumbprint: key.thumbprint,
      revokedAt: key.revokedAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
    })),
    access: {
      resourceIds: resources.map(({ id }) => id),
      resources,
      scopeIds: scopes.map(({ id }) => id),
      scopeKeys: scopes.map(({ key }) => key),
    },
  };
}

function clientMetadata(client: {
  clientId: string;
  name: string;
  enabled: boolean;
  version: number;
}) {
  return {
    clientId: client.clientId,
    name: client.name,
    enabled: client.enabled,
    version: client.version,
  };
}

function keyAudit(
  eventType: "machine_key.registered" | "machine_key.revoked",
  client: { id: string; clientId: string },
  key: { id: string; kid: string; thumbprint: string; revokedAt: Date | null },
  actor: AdminActor,
) {
  return {
    eventType,
    actorType: "user" as const,
    actorId: actor.id,
    ...(actor.email ? { actorEmail: actor.email } : {}),
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    outcome: "success" as const,
    subjectType: "machine_key",
    subjectId: key.id,
    metadata: {
      clientId: client.clientId,
      kid: key.kid,
      thumbprint: key.thumbprint,
      revokedAt: key.revokedAt?.toISOString() ?? null,
    },
  };
}

function accessSnapshot(client: MachineWithRelations) {
  return {
    resourceIdentifiers: client.allowedResources
      .map(({ resource }) => resource.resourceIdentifier)
      .sort(),
    scopeKeys: client.allowedScopes.map(({ scope }) => scope.key).sort(),
  };
}

function emptyAccess() {
  return { resourceIdentifiers: [] as string[], scopeKeys: [] as string[] };
}

function accessAudit(
  client: MachineWithRelations,
  before: ReturnType<typeof emptyAccess>,
  versionBefore: number,
  actor: AdminActor,
) {
  return {
    eventType: "machine_access.replaced" as const,
    actorType: "user" as const,
    actorId: actor.id,
    ...(actor.email ? { actorEmail: actor.email } : {}),
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    outcome: "success" as const,
    subjectType: "machine_client",
    subjectId: client.id,
    metadata: {
      clientId: client.clientId,
      beforeResources: before.resourceIdentifiers,
      afterResources: client.allowedResources
        .map(({ resource }) => resource.resourceIdentifier)
        .sort(),
      beforeScopes: before.scopeKeys,
      afterScopes: client.allowedScopes.map(({ scope }) => scope.key).sort(),
      versionBefore,
      versionAfter: client.version,
    },
  };
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
