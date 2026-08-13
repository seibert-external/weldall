import { db, Prisma } from "@weldall/db";
import { assertPublicP256 } from "@weldall/sdk";
import { calculateJwkThumbprint, type JWK } from "jose";
import { AdminDomainError, type AdminActor, type ManagementDto } from "../admin/service";
import {
  lockConfigurationChanges,
  managementBindingInclude,
  managementMetadata,
} from "../domain/configuration";
import {
  deleteMachine,
  reconcileMachine,
  PrimitiveMutationError,
  type MutationActor,
} from "../domain/primitive-mutations";

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
  iacBinding: managementBindingInclude,
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
      await lockConfigurationChanges(tx);
      const access = await validateAccess(input.access, tx);
      try {
        return serialize(
          await reconcileMachine(
            tx,
            {
              clientId,
              name,
              enabled: true,
              resourceKeys: await resourceKeysForIds(tx, access.resourceIds),
              scopeKeys: await scopeKeysForIds(tx, access.scopeIds),
              publicKeys: { [key.kid]: key.publicJwk },
              expectedVersion: null,
            },
            mutationActor(actor),
          ),
        );
      } catch (error) {
        throw mapPrimitiveError(error);
      }
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
    await lockConfigurationChanges(tx);
    const current = await tx.machineClient.findUnique({ where: { id: input.id }, include });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Machine client not found.");
    try {
      return serialize(
        await reconcileMachine(
          tx,
          {
            id: current.id,
            clientId: current.clientId,
            name,
            enabled: input.enabled,
            resourceKeys: current.allowedResources.map(({ resource }) => resource.key),
            scopeKeys: current.allowedScopes.map(({ scope }) => scope.key),
            publicKeys: Object.fromEntries(
              current.keys
                .filter(({ revokedAt }) => !revokedAt)
                .map(({ kid, publicJwk }) => [kid, publicJwk]),
            ) as Record<string, JWK>,
            expectedVersion: input.expectedVersion,
          },
          mutationActor(actor),
        ),
      );
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function deleteMachineClient(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    try {
      return await deleteMachine(tx, input, mutationActor(actor));
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function registerMachineKey(
  input: { clientId: string; kid: string; publicJwk: unknown },
  actor: AdminActor,
): Promise<MachineClientDto> {
  const key = await parseKey(input);
  try {
    return await db.$transaction(async (tx) => {
      await lockConfigurationChanges(tx);
      const client = await tx.machineClient.findUnique({ where: { id: input.clientId }, include });
      if (!client) throw new AdminDomainError("NOT_FOUND", "Machine client not found.");
      try {
        return serialize(
          await reconcileMachine(
            tx,
            {
              id: client.id,
              clientId: client.clientId,
              name: client.name,
              enabled: client.enabled,
              resourceKeys: client.allowedResources.map(({ resource }) => resource.key),
              scopeKeys: client.allowedScopes.map(({ scope }) => scope.key),
              publicKeys: {
                ...Object.fromEntries(
                  client.keys
                    .filter(({ revokedAt }) => !revokedAt)
                    .map(({ kid, publicJwk }) => [kid, publicJwk]),
                ),
                [key.kid]: key.publicJwk,
              } as Record<string, JWK>,
              expectedVersion: client.version,
            },
            mutationActor(actor),
          ),
        );
      } catch (error) {
        throw mapPrimitiveError(error);
      }
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
    await lockConfigurationChanges(tx);
    const client = await tx.machineClient.findUnique({ where: { id: input.clientId }, include });
    const key = client?.keys.find(({ id }) => id === input.keyId);
    if (!client || !key) throw new AdminDomainError("NOT_FOUND", "Machine key not found.");
    if (key.revokedAt) return serialize(client);
    try {
      return serialize(
        await reconcileMachine(
          tx,
          {
            id: client.id,
            clientId: client.clientId,
            name: client.name,
            enabled: client.enabled,
            resourceKeys: client.allowedResources.map(({ resource }) => resource.key),
            scopeKeys: client.allowedScopes.map(({ scope }) => scope.key),
            publicKeys: Object.fromEntries(
              client.keys
                .filter((item) => !item.revokedAt && item.id !== key.id)
                .map(({ kid, publicJwk }) => [kid, publicJwk]),
            ) as Record<string, JWK>,
            expectedVersion: client.version,
          },
          mutationActor(actor),
        ),
      );
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function replaceMachineAccess(
  input: { clientId: string; resourceIds: string[]; scopeIds: string[]; expectedVersion: number },
  actor: AdminActor,
): Promise<MachineClientDto> {
  validateAccessShape(input);
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    const current = await tx.machineClient.findUnique({ where: { id: input.clientId }, include });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Machine client not found.");
    const access = await validateAccess(
      input,
      tx,
      new Set(current.allowedResources.map(({ resourceId }) => resourceId)),
    );
    try {
      return serialize(
        await reconcileMachine(
          tx,
          {
            id: current.id,
            clientId: current.clientId,
            name: current.name,
            enabled: current.enabled,
            resourceKeys: await resourceKeysForIds(tx, access.resourceIds),
            scopeKeys: await scopeKeysForIds(tx, access.scopeIds),
            publicKeys: Object.fromEntries(
              current.keys
                .filter(({ revokedAt }) => !revokedAt)
                .map(({ kid, publicJwk }) => [kid, publicJwk]),
            ) as Record<string, JWK>,
            expectedVersion: input.expectedVersion,
          },
          mutationActor(actor),
        ),
      );
    } catch (error) {
      throw mapPrimitiveError(error);
    }
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

async function resourceKeysForIds(tx: Prisma.TransactionClient, ids: string[]): Promise<string[]> {
  return (
    await tx.downstreamResource.findMany({
      where: { id: { in: ids } },
      select: { key: true },
    })
  ).map(({ key }) => key);
}

async function scopeKeysForIds(tx: Prisma.TransactionClient, ids: string[]): Promise<string[]> {
  return (await tx.scope.findMany({ where: { id: { in: ids } }, select: { key: true } })).map(
    ({ key }) => key,
  );
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
    management: managementMetadata(client.iacBinding),
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

function mutationActor(actor: AdminActor): MutationActor {
  return {
    type: "user",
    id: actor.id,
    ...(actor.email ? { email: actor.email } : {}),
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    source: "admin_api",
  };
}

function mapPrimitiveError(error: unknown): unknown {
  if (!(error instanceof PrimitiveMutationError)) return error;
  return new AdminDomainError(error.code, error.message, error.details);
}
