import { db, Prisma } from "@weldall/db";
import { assertPublicP256 } from "@weldall/sdk";
import { calculateJwkThumbprint, type JWK } from "jose";
import { AdminDomainError, type AdminActor } from "../admin/service";
import { prismaAuditWriter } from "../audit/service";

const clientIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const kidPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const include = {
  keys: { orderBy: [{ createdAt: "desc" as const }, { kid: "asc" as const }] },
  grants: {
    orderBy: { createdAt: "asc" as const },
    include: {
      resource: { select: { id: true, key: true, name: true, resourceIdentifier: true } },
      scopes: { include: { scope: { select: { id: true, key: true } } } },
    },
  },
} satisfies Prisma.WorkloadClientInclude;

type WorkloadWithRelations = Prisma.WorkloadClientGetPayload<{ include: typeof include }>;

export interface WorkloadClientDto {
  id: string;
  clientId: string;
  name: string;
  enabled: boolean;
  deactivatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  keys: Array<{
    id: string;
    kid: string;
    publicJwk: JWK;
    thumbprint: string;
    notBefore: string;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>;
  grants: Array<{
    id: string;
    resourceId: string;
    resourceKey: string;
    resourceName: string;
    resourceIdentifier: string;
    enabled: boolean;
    revokedAt: string | null;
    version: number;
    scopeIds: string[];
    scopeKeys: string[];
  }>;
}

export async function listWorkloadClients(): Promise<WorkloadClientDto[]> {
  return (await db.workloadClient.findMany({ orderBy: { name: "asc" }, include })).map(serialize);
}

export async function getWorkloadClient(id: string): Promise<WorkloadClientDto> {
  const client = await db.workloadClient.findUnique({ where: { id }, include });
  if (!client) throw new AdminDomainError("NOT_FOUND", "Workload client not found.");
  return serialize(client);
}

export async function listWorkloadResourceOptions(): Promise<
  Array<{
    id: string;
    name: string;
    resourceIdentifier: string;
    scopes: Array<{ id: string; key: string }>;
  }>
> {
  const resources = await db.downstreamResource.findMany({
    where: { enabled: true },
    orderBy: [{ name: "asc" }, { key: "asc" }],
    select: {
      id: true,
      name: true,
      resourceIdentifier: true,
      scopes: { include: { scope: { select: { id: true, key: true } } } },
    },
  });
  return resources.map((resource) => ({
    id: resource.id,
    name: resource.name,
    resourceIdentifier: resource.resourceIdentifier,
    scopes: resource.scopes
      .map(({ scope }) => scope)
      .sort((left, right) => left.key.localeCompare(right.key)),
  }));
}

export async function createWorkloadClient(
  input: {
    clientId: string;
    name: string;
    key: {
      kid: string;
      publicJwk: unknown;
      notBefore?: Date | undefined;
      expiresAt?: Date | null | undefined;
    };
    grants: Array<{ resourceId: string; scopeIds: string[] }>;
  },
  actor: AdminActor,
): Promise<WorkloadClientDto> {
  const clientId = parseClientId(input.clientId);
  const name = parseName(input.name);
  const key = await parseKey(input.key);
  validateGrantShape(input.grants, false);
  try {
    return await db.$transaction(async (tx) => {
      await lockResourceChanges(tx);
      const grants = await validateGrants(input.grants, tx, false);
      const client = await tx.workloadClient.create({
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
              notBefore: key.notBefore,
              expiresAt: key.expiresAt,
              createdBy: actor.id,
            },
          },
          grants: {
            create: grants.map((grant) => ({
              resourceId: grant.resourceId,
              createdBy: actor.id,
              updatedBy: actor.id,
              scopes: { create: grant.scopeIds.map((scopeId) => ({ scopeId })) },
            })),
          },
        },
        include,
      });
      await prismaAuditWriter.write(
        {
          eventType: "workload_client.created",
          actorType: "user",
          actorId: actor.id,
          ...(actor.email ? { actorEmail: actor.email } : {}),
          requestId: actor.requestId,
          ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
          outcome: "success",
          subjectType: "workload_client",
          subjectId: client.id,
          metadata: clientMetadata(client),
        },
        tx,
      );
      await prismaAuditWriter.write(
        keyAudit("workload_key.registered", client, client.keys[0]!, actor),
        tx,
      );
      for (const grant of client.grants)
        await prismaAuditWriter.write(
          grantAudit("workload_grants.replaced", client, grant, [], actor),
          tx,
        );
      return serialize(client);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new AdminDomainError("CONFLICT", "Client ID, key ID, or key is already registered.");
    throw error;
  }
}

export async function updateWorkloadClient(
  input: { id: string; name: string; enabled: boolean; expectedVersion: number },
  actor: AdminActor,
): Promise<WorkloadClientDto> {
  const name = parseName(input.name);
  return db.$transaction(async (tx) => {
    const current = await tx.workloadClient.findUnique({ where: { id: input.id } });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Workload client not found.");
    if (current.version !== input.expectedVersion)
      throw new AdminDomainError("CONFLICT", "The workload client changed. Reload and try again.");
    const changed = await tx.workloadClient.updateMany({
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
      throw new AdminDomainError("CONFLICT", "The workload client changed. Reload and try again.");
    const client = await tx.workloadClient.findUniqueOrThrow({ where: { id: input.id }, include });
    await prismaAuditWriter.write(
      {
        eventType: input.enabled ? "workload_client.updated" : "workload_client.deactivated",
        actorType: "user",
        actorId: actor.id,
        ...(actor.email ? { actorEmail: actor.email } : {}),
        requestId: actor.requestId,
        ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
        outcome: "success",
        subjectType: "workload_client",
        subjectId: client.id,
        metadata: clientMetadata(client),
      },
      tx,
    );
    return serialize(client);
  });
}

export async function registerWorkloadKey(
  input: {
    clientId: string;
    kid: string;
    publicJwk: unknown;
    notBefore?: Date | undefined;
    expiresAt?: Date | null | undefined;
  },
  actor: AdminActor,
): Promise<WorkloadClientDto> {
  const key = await parseKey(input);
  try {
    return await db.$transaction(async (tx) => {
      const client = await tx.workloadClient.findUnique({ where: { id: input.clientId } });
      if (!client) throw new AdminDomainError("NOT_FOUND", "Workload client not found.");
      const created = await tx.workloadClientKey.create({
        data: {
          workloadClientId: client.id,
          kid: key.kid,
          publicJwk: key.publicJwk as Prisma.InputJsonObject,
          thumbprint: key.thumbprint,
          notBefore: key.notBefore,
          expiresAt: key.expiresAt,
          createdBy: actor.id,
        },
      });
      await prismaAuditWriter.write(
        keyAudit("workload_key.registered", client, created, actor),
        tx,
      );
      return serialize(
        await tx.workloadClient.findUniqueOrThrow({ where: { id: client.id }, include }),
      );
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new AdminDomainError("CONFLICT", "This key ID or public key is already registered.");
    throw error;
  }
}

export async function revokeWorkloadKey(
  input: { clientId: string; keyId: string },
  actor: AdminActor,
): Promise<WorkloadClientDto> {
  return db.$transaction(async (tx) => {
    const [client, key] = await Promise.all([
      tx.workloadClient.findUnique({ where: { id: input.clientId } }),
      tx.workloadClientKey.findUnique({ where: { id: input.keyId } }),
    ]);
    if (!client || !key || key.workloadClientId !== client.id)
      throw new AdminDomainError("NOT_FOUND", "Workload key not found.");
    const revoked = key.revokedAt
      ? key
      : await tx.workloadClientKey.update({
          where: { id: key.id },
          data: { revokedAt: new Date(), revokedBy: actor.id },
        });
    if (!key.revokedAt)
      await prismaAuditWriter.write(keyAudit("workload_key.revoked", client, revoked, actor), tx);
    return serialize(
      await tx.workloadClient.findUniqueOrThrow({ where: { id: client.id }, include }),
    );
  });
}

export async function replaceWorkloadGrant(
  input: {
    clientId: string;
    resourceId: string;
    scopeIds: string[];
    expectedVersion: number | null;
  },
  actor: AdminActor,
): Promise<WorkloadClientDto> {
  const rawGrant = { resourceId: input.resourceId, scopeIds: input.scopeIds };
  validateGrantShape([rawGrant], true);
  return db.$transaction(async (tx) => {
    await lockResourceChanges(tx);
    const [grantInput] = await validateGrants([rawGrant], tx, true);
    if (!grantInput) throw new AdminDomainError("INVALID_RESOURCE", "Resource grant is required.");
    const client = await tx.workloadClient.findUnique({ where: { id: input.clientId } });
    if (!client) throw new AdminDomainError("NOT_FOUND", "Workload client not found.");
    const current = await tx.workloadResourceGrant.findUnique({
      where: {
        workloadClientId_resourceId: {
          workloadClientId: client.id,
          resourceId: grantInput.resourceId,
        },
      },
      include: { scopes: { include: { scope: true } }, resource: true },
    });
    if ((current?.version ?? null) !== input.expectedVersion)
      throw new AdminDomainError("CONFLICT", "The workload grant changed. Reload and try again.");
    const before = current?.scopes.map(({ scope }) => scope.key).sort() ?? [];
    const revoke = grantInput.scopeIds.length === 0;
    const grant = current
      ? await tx.workloadResourceGrant.update({
          where: { id: current.id },
          data: {
            enabled: !revoke,
            revokedAt: revoke ? new Date() : null,
            updatedBy: actor.id,
            version: { increment: 1 },
            scopes: {
              deleteMany: {},
              create: grantInput.scopeIds.map((scopeId) => ({ scopeId })),
            },
          },
          include: {
            resource: true,
            scopes: { include: { scope: true } },
          },
        })
      : await tx.workloadResourceGrant.create({
          data: {
            workloadClientId: client.id,
            resourceId: grantInput.resourceId,
            enabled: !revoke,
            revokedAt: revoke ? new Date() : null,
            createdBy: actor.id,
            updatedBy: actor.id,
            scopes: { create: grantInput.scopeIds.map((scopeId) => ({ scopeId })) },
          },
          include: { resource: true, scopes: { include: { scope: true } } },
        });
    await prismaAuditWriter.write(
      grantAudit(
        revoke ? "workload_grants.revoked" : "workload_grants.replaced",
        client,
        grant,
        before,
        actor,
      ),
      tx,
    );
    return serialize(
      await tx.workloadClient.findUniqueOrThrow({ where: { id: client.id }, include }),
    );
  });
}

async function parseKey(input: {
  kid: string;
  publicJwk: unknown;
  notBefore?: Date | undefined;
  expiresAt?: Date | null | undefined;
}) {
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
  const notBefore = input.notBefore ?? new Date();
  const expiresAt = input.expiresAt ?? null;
  if (!Number.isFinite(notBefore.getTime()) || (expiresAt && !Number.isFinite(expiresAt.getTime())))
    throw new AdminDomainError("INVALID_RESOURCE", "Key dates are invalid.");
  if (expiresAt && expiresAt <= notBefore)
    throw new AdminDomainError("INVALID_RESOURCE", "Key expiry must be after activation.");
  return {
    kid,
    publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk, "sha256"),
    notBefore,
    expiresAt,
  };
}

function validateGrantShape(
  grants: Array<{ resourceId: string; scopeIds: string[] }>,
  allowRevocation: boolean,
): void {
  if (
    grants.length > 100 ||
    new Set(grants.map(({ resourceId }) => resourceId)).size !== grants.length
  )
    throw new AdminDomainError("INVALID_RESOURCE", "Each resource may have one workload grant.");
  if (
    grants.some(
      (grant) =>
        grant.scopeIds.length > 100 ||
        (!allowRevocation && grant.scopeIds.length === 0) ||
        new Set(grant.scopeIds).size !== grant.scopeIds.length,
    )
  )
    throw new AdminDomainError(
      "INVALID_SCOPE",
      allowRevocation
        ? "Grant scopes must be unique."
        : "A new workload grant needs at least one unique scope.",
    );
}

async function validateGrants(
  grants: Array<{ resourceId: string; scopeIds: string[] }>,
  client: Prisma.TransactionClient,
  allowDisabledRevocation: boolean,
) {
  const result = [];
  for (const grant of grants) {
    const resource = await client.downstreamResource.findUnique({
      where: { id: grant.resourceId },
      include: { scopes: { select: { scopeId: true } } },
    });
    if (
      !resource ||
      (!resource.enabled && !(allowDisabledRevocation && grant.scopeIds.length === 0))
    )
      throw new AdminDomainError("INVALID_RESOURCE", "Choose an enabled resource.");
    const supported = new Set(resource.scopes.map(({ scopeId }) => scopeId));
    if (grant.scopeIds.some((scopeId) => !supported.has(scopeId)))
      throw new AdminDomainError(
        "INVALID_SCOPE",
        "Every granted scope must be supported by that resource.",
      );
    result.push({ resourceId: resource.id, scopeIds: [...grant.scopeIds] });
  }
  return result;
}

async function lockResourceChanges(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(49350618)`;
}

function parseClientId(value: string): string {
  const clientId = value.trim();
  if (!clientIdPattern.test(clientId) || clientId === "weldall-cli")
    throw new AdminDomainError("INVALID_RESOURCE", "Enter a safe, unique workload client ID.");
  return clientId;
}

function parseName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200)
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      "Workload names must contain 1 to 200 characters.",
    );
  return name;
}

function serialize(client: WorkloadWithRelations): WorkloadClientDto {
  return {
    id: client.id,
    clientId: client.clientId,
    name: client.name,
    enabled: client.enabled,
    deactivatedAt: client.deactivatedAt?.toISOString() ?? null,
    version: client.version,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
    keys: client.keys.map((key) => ({
      id: key.id,
      kid: key.kid,
      publicJwk: key.publicJwk as JWK,
      thumbprint: key.thumbprint,
      notBefore: key.notBefore.toISOString(),
      expiresAt: key.expiresAt?.toISOString() ?? null,
      revokedAt: key.revokedAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
    })),
    grants: client.grants.map((grant) => ({
      id: grant.id,
      resourceId: grant.resource.id,
      resourceKey: grant.resource.key,
      resourceName: grant.resource.name,
      resourceIdentifier: grant.resource.resourceIdentifier,
      enabled: grant.enabled,
      revokedAt: grant.revokedAt?.toISOString() ?? null,
      version: grant.version,
      scopeIds: grant.scopes.map(({ scope }) => scope.id).sort(),
      scopeKeys: grant.scopes.map(({ scope }) => scope.key).sort(),
    })),
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
  eventType: "workload_key.registered" | "workload_key.revoked",
  client: { id: string; clientId: string },
  key: {
    id: string;
    kid: string;
    thumbprint: string;
    notBefore: Date;
    expiresAt: Date | null;
    revokedAt: Date | null;
  },
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
    subjectType: "workload_key",
    subjectId: key.id,
    metadata: {
      clientId: client.clientId,
      kid: key.kid,
      thumbprint: key.thumbprint,
      notBefore: key.notBefore.toISOString(),
      expiresAt: key.expiresAt?.toISOString() ?? null,
      revokedAt: key.revokedAt?.toISOString() ?? null,
    },
  };
}

function grantAudit(
  eventType: "workload_grants.replaced" | "workload_grants.revoked",
  client: { clientId: string },
  grant: {
    id: string;
    version: number;
    resource: { resourceIdentifier: string };
    scopes: Array<{ scope: { key: string } }>;
  },
  beforeScopes: string[],
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
    subjectType: "workload_grant",
    subjectId: grant.id,
    metadata: {
      clientId: client.clientId,
      resourceIdentifier: grant.resource.resourceIdentifier,
      beforeScopes,
      afterScopes: grant.scopes.map(({ scope }) => scope.key).sort(),
      versionBefore: Math.max(0, grant.version - 1),
      versionAfter: grant.version,
    },
  };
}
