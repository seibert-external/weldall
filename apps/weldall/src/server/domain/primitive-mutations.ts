import { createHash, randomUUID } from "node:crypto";
import { ADMIN_SCOPE_KEY, IAC_SCOPE_KEY, Prisma } from "@weldall/db";
import {
  assertPublicP256,
  normalizeAuthorizationServer,
  normalizeRequestPrefix,
  normalizeResourceIdentifier,
  requestPrefixesOverlap,
} from "@weldall/sdk";
import { calculateJwkThumbprint, type JWK } from "jose";
import { z } from "zod";
import { prismaAuditWriter, type AuditEventType } from "../audit/service";
import { decryptProviderToken } from "../group-providers/credentials";
import { createGroupProviderAdapter } from "../group-providers/registry";
import { scopeKeySchema } from "../policy/scope-key";

export type MutationSource =
  "admin_api" | "weldall_up" | "static_manifest_import" | "scope_delete_cascade";
export interface MutationActor {
  type: "user" | "machine";
  id: string;
  email?: string | null;
  requestId: string;
  correlationId?: string;
  source: MutationSource;
}

export class PrimitiveMutationError extends Error {
  constructor(
    readonly code:
      | "CONFLICT"
      | "INVALID_EMAIL"
      | "INVALID_GROUP"
      | "INVALID_PROVIDER"
      | "INVALID_RESOURCE"
      | "INVALID_SCOPE"
      | "LAST_ADMIN"
      | "NOT_FOUND"
      | "SYSTEM_SCOPE",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PrimitiveMutationError";
  }
}

export interface GroupAssignmentPreflight {
  providerId: string;
  providerKey: string;
  providerVersion: number;
  providerEnabled: boolean;
  groupId: string;
  groupName: string;
}

const resourceInclude = {
  scopes: { include: { scope: { select: { id: true, key: true } } } },
  requestPrefixes: { orderBy: { urlPrefix: "asc" as const } },
  discoveredCatalog: { include: { _count: { select: { skills: true } } } },
  iacBinding: { include: { workspace: { select: { id: true, name: true } } } },
} as const;
const scopeInclude = {
  grants: {
    include: {
      assignment: {
        include: { grants: { include: { scope: { select: { key: true } } } } },
      },
    },
  },
  groupGrants: {
    include: {
      assignment: {
        include: {
          provider: { select: { key: true } },
          grants: { include: { scope: { select: { key: true } } } },
        },
      },
    },
  },
  _count: { select: { grants: true, groupGrants: true } },
  iacBinding: { include: { workspace: { select: { id: true, name: true } } } },
} as const;
const emailInclude = {
  grants: { include: { scope: { select: { id: true, key: true } } } },
  iacBinding: { include: { workspace: { select: { id: true, name: true } } } },
} as const;
const groupInclude = {
  provider: { select: { key: true, name: true } },
  grants: { include: { scope: { select: { key: true } } } },
  iacBinding: { include: { workspace: { select: { id: true, name: true } } } },
} as const;
const machineInclude = {
  keys: { orderBy: [{ createdAt: "desc" as const }, { kid: "asc" as const }] },
  allowedResources: {
    include: {
      resource: { select: { id: true, key: true, name: true, resourceIdentifier: true } },
    },
  },
  allowedScopes: { include: { scope: { select: { id: true, key: true } } } },
  iacBinding: { include: { workspace: { select: { id: true, name: true } } } },
} satisfies Prisma.MachineClientInclude;

export function normalizeMutationEmail(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!z.string().email().max(320).safeParse(value).success)
    throw new PrimitiveMutationError("INVALID_EMAIL", "Enter a valid email address.");
  return value;
}

export async function mutateScope(
  tx: Prisma.TransactionClient,
  input:
    | { action: "create"; key: string; description: string }
    | { action: "update"; id: string; description: string; expectedVersion: number }
    | { action: "delete"; id: string; expectedVersion: number },
  actor: MutationActor,
): Promise<any> {
  if (input.action === "create") {
    const key = parseScopeKey(input.key);
    const description = parseDescription(input.description);
    if (await tx.scope.findUnique({ where: { key }, select: { id: true } }))
      throw new PrimitiveMutationError("CONFLICT", `Scope ${key} already exists.`);
    const scope = await tx.scope.create({
      data: { key, description, createdBy: actor.id, updatedBy: actor.id },
      include: scopeInclude,
    });
    await scopeAudit(tx, actor, "resource_scopes.created", null, scope);
    return scope;
  }
  const current = await tx.scope.findUnique({ where: { id: input.id }, include: scopeInclude });
  if (!current) throw new PrimitiveMutationError("NOT_FOUND", "Scope not found.");
  if (current.isSystem)
    throw new PrimitiveMutationError("SYSTEM_SCOPE", "System scopes cannot be changed.");
  assertVersion(current.version, input.expectedVersion, "scope");
  if (input.action === "update") {
    const description = parseDescription(input.description);
    if (description === current.description) return current;
    const write = await tx.scope.updateMany({
      where: { id: current.id, version: input.expectedVersion },
      data: { description, version: { increment: 1 }, updatedBy: actor.id },
    });
    if (write.count !== 1) conflict("scope");
    const updated = await tx.scope.findUniqueOrThrow({
      where: { id: current.id },
      include: scopeInclude,
    });
    await scopeAudit(tx, actor, "resource_scopes.replaced", current, updated);
    return updated;
  }
  const [skill, resource, machine] = await Promise.all([
    tx.skill.findFirst({ where: { requiredScopes: { has: current.key } }, select: { slug: true } }),
    tx.resourceScope.findFirst({
      where: { scopeId: current.id },
      include: { resource: { select: { key: true } } },
    }),
    tx.machineAllowedScope.findFirst({
      where: { scopeId: current.id },
      include: { client: { select: { clientId: true } } },
    }),
  ]);
  if (skill)
    throw new PrimitiveMutationError(
      "CONFLICT",
      `Scope ${current.key} is required by skill ${skill.slug}. Update that skill first.`,
    );
  if (resource)
    throw new PrimitiveMutationError(
      "CONFLICT",
      `Scope ${current.key} is supported by resource ${resource.resource.key}. Update that resource first.`,
    );
  if (machine)
    throw new PrimitiveMutationError(
      "CONFLICT",
      `Scope ${current.key} is selected by machine ${machine.client.clientId}. Remove it from machine access first.`,
    );
  const affectedEmails = current.grants.map(({ assignment }) => ({
    id: assignment.id,
    email: assignment.normalizedEmail,
    version: assignment.version,
    beforeScopes: assignment.grants.map(({ scope }) => scope.key).sort(),
  }));
  const affectedGroups = current.groupGrants.map(({ assignment }) => ({
    id: assignment.id,
    providerId: assignment.providerId,
    providerKey: assignment.provider.key,
    groupId: assignment.groupId,
    groupName: assignment.groupName,
    version: assignment.version,
    beforeScopes: assignment.grants.map(({ scope }) => scope.key).sort(),
  }));
  const deleted = await tx.scope.deleteMany({
    where: { id: current.id, version: input.expectedVersion },
  });
  if (deleted.count !== 1) conflict("scope");
  for (const assignment of affectedEmails) {
    const afterScopes = assignment.beforeScopes.filter((key) => key !== current.key);
    const write = await tx.emailScopeAssignment.updateMany({
      where: { id: assignment.id, version: assignment.version },
      data: { version: { increment: 1 }, updatedBy: actor.id },
    });
    if (write.count !== 1) conflict("affected assignment");
    await basicAudit(
      tx,
      { ...actor, source: "scope_delete_cascade" },
      afterScopes.length ? "user_scopes.replaced" : "user_scopes.deleted",
      "email_scope_assignment",
      assignment.id,
      {
        normalizedEmail: assignment.email,
        beforeScopes: assignment.beforeScopes,
        afterScopes,
        addedScopes: [],
        removedScopes: [current.key],
        source: "scope_delete_cascade",
        versionBefore: assignment.version,
        versionAfter: assignment.version + 1,
      },
    );
  }
  for (const assignment of affectedGroups) {
    const afterScopes = assignment.beforeScopes.filter((key) => key !== current.key);
    const write = await tx.groupScopeAssignment.updateMany({
      where: { id: assignment.id, version: assignment.version },
      data: { version: { increment: 1 }, updatedBy: actor.id },
    });
    if (write.count !== 1) conflict("affected group assignment");
    await basicAudit(
      tx,
      { ...actor, source: "scope_delete_cascade" },
      afterScopes.length ? "group_scopes.replaced" : "group_scopes.deleted",
      "group_scope_assignment",
      assignment.id,
      {
        providerId: assignment.providerId,
        providerKey: assignment.providerKey,
        groupId: assignment.groupId,
        groupName: assignment.groupName,
        beforeScopes: assignment.beforeScopes,
        afterScopes,
        addedScopes: [],
        removedScopes: [current.key],
        source: "scope_delete_cascade",
        versionBefore: assignment.version,
        versionAfter: assignment.version + 1,
      },
    );
  }
  await scopeAudit(tx, actor, "resource_scopes.deleted", current, null);
  return { id: current.id, affectedAssignments: affectedEmails.length + affectedGroups.length };
}

export async function mutateResource(
  tx: Prisma.TransactionClient,
  input:
    | ({ action: "create"; key: string; resourceIdentifier: string } & ResourceMutableInput)
    | ({ action: "update"; id: string; expectedVersion: number } & ResourceMutableInput)
    | { action: "delete"; id: string; expectedVersion: number },
  actor: MutationActor,
): Promise<any> {
  if (input.action === "delete") {
    const current = await tx.downstreamResource.findUnique({
      where: { id: input.id },
      include: resourceInclude,
    });
    if (!current) throw new PrimitiveMutationError("NOT_FOUND", "Resource not found.");
    assertVersion(current.version, input.expectedVersion, "resource");
    const access = await tx.machineAllowedResource.findFirst({
      where: { resourceId: current.id },
      include: { client: { select: { clientId: true } } },
    });
    if (access)
      throw new PrimitiveMutationError(
        "CONFLICT",
        `Resource ${current.key} is selected by machine ${access.client.clientId}. Remove it from machine access first.`,
      );
    const deleted = await tx.downstreamResource.deleteMany({
      where: { id: current.id, version: input.expectedVersion },
    });
    if (deleted.count !== 1) conflict("resource");
    await resourceAudit(tx, actor, "resource_scopes.deleted", current, null);
    return { id: current.id };
  }
  const parsed = parseResource(input, input.action === "create");
  const current =
    input.action === "update"
      ? await tx.downstreamResource.findUnique({
          where: { id: input.id },
          include: resourceInclude,
        })
      : null;
  if (input.action === "update") {
    if (!current) throw new PrimitiveMutationError("NOT_FOUND", "Resource not found.");
    assertVersion(current.version, input.expectedVersion, "resource");
  }
  const scopes = await scopesByKeys(tx, parsed.scopeKeys);
  await assertPrefixes(
    tx,
    parsed.requestPrefixes,
    current?.id,
    input.action === "create" ? input.key : undefined,
  );
  if (!current) {
    const created = await tx.downstreamResource.create({
      data: {
        key: (input as any).key,
        name: parsed.name,
        resourceIdentifier: normalizeResourceIdentifier((input as any).resourceIdentifier),
        authorizationServer: parsed.authorizationServer,
        downstreamClientId: parsed.downstreamClientId,
        enabled: parsed.enabled,
        skillDiscoveryEnabled: parsed.skillDiscoveryEnabled,
        createdBy: actor.id,
        updatedBy: actor.id,
        scopes: { create: scopes.map((scope) => ({ scopeId: scope.id })) },
        requestPrefixes: {
          create: parsed.requestPrefixes.map((urlPrefix) => ({ urlPrefix, createdBy: actor.id })),
        },
        ...(parsed.skillDiscoveryEnabled
          ? { discoveredCatalog: { create: { nextRefreshAt: new Date() } } }
          : {}),
      },
      include: resourceInclude,
    });
    await resourceAudit(tx, actor, "resource_scopes.created", null, created);
    return created;
  }
  const unchanged =
    current.name === parsed.name &&
    current.authorizationServer === parsed.authorizationServer &&
    current.downstreamClientId === parsed.downstreamClientId &&
    current.enabled === parsed.enabled &&
    current.skillDiscoveryEnabled === parsed.skillDiscoveryEnabled &&
    same(current.scopes.map(({ scope }) => scope.key).sort(), parsed.scopeKeys) &&
    same(current.requestPrefixes.map(({ urlPrefix }) => urlPrefix).sort(), parsed.requestPrefixes);
  if (unchanged) return current;
  await tx.resourceScope.deleteMany({ where: { resourceId: current.id } });
  if (scopes.length)
    await tx.resourceScope.createMany({
      data: scopes.map((scope) => ({ resourceId: current.id, scopeId: scope.id })),
    });
  await tx.resourceRequestPrefix.deleteMany({ where: { resourceId: current.id } });
  await tx.resourceRequestPrefix.createMany({
    data: parsed.requestPrefixes.map((urlPrefix) => ({
      resourceId: current.id,
      urlPrefix,
      createdBy: actor.id,
    })),
  });
  const write = await tx.downstreamResource.updateMany({
    where: { id: current.id, version: (input as any).expectedVersion },
    data: {
      name: parsed.name,
      authorizationServer: parsed.authorizationServer,
      downstreamClientId: parsed.downstreamClientId,
      enabled: parsed.enabled,
      skillDiscoveryEnabled: parsed.skillDiscoveryEnabled,
      version: { increment: 1 },
      updatedBy: actor.id,
    },
  });
  if (write.count !== 1) conflict("resource");
  if (parsed.skillDiscoveryEnabled)
    await tx.discoveredSkillCatalog.upsert({
      where: { resourceId: current.id },
      create: { resourceId: current.id, nextRefreshAt: new Date() },
      update: { nextRefreshAt: new Date(), refreshLeaseId: null, refreshLeaseUntil: null },
    });
  const updated = await tx.downstreamResource.findUniqueOrThrow({
    where: { id: current.id },
    include: resourceInclude,
  });
  await resourceAudit(tx, actor, "resource_scopes.replaced", current, updated);
  return updated;
}

type ResourceMutableInput = {
  name: string;
  authorizationServer: string;
  downstreamClientId: string;
  enabled: boolean;
  skillDiscoveryEnabled: boolean;
  scopeKeys: string[];
  requestPrefixes: string[];
};

export async function mutateEmailAssignment(
  tx: Prisma.TransactionClient,
  input: { email: string; scopeKeys: string[]; expectedVersion: number | null },
  actor: MutationActor,
): Promise<any | null> {
  const email = normalizeMutationEmail(input.email);
  const keys = parseScopeKeys(input.scopeKeys);
  if (keys.includes(IAC_SCOPE_KEY))
    throw new PrimitiveMutationError("SYSTEM_SCOPE", `${IAC_SCOPE_KEY} is machine-only.`);
  const current = await tx.emailScopeAssignment.findUnique({
    where: { normalizedEmail: email },
    include: emailInclude,
  });
  const before = current ? current.grants.map(({ scope }) => scope.key).sort() : [];
  if (
    input.expectedVersion === null
      ? current && before.length
      : !current || current.version !== input.expectedVersion
  )
    throw new PrimitiveMutationError("CONFLICT", "The assignment changed. Reload and try again.", {
      currentVersion: current?.version ?? null,
    });
  if (same(before, keys)) return current;
  const scopes = await scopesByKeys(tx, keys);
  if (before.includes(ADMIN_SCOPE_KEY) && !keys.includes(ADMIN_SCOPE_KEY)) {
    const [admins, users] = await Promise.all([
      tx.emailScopeAssignment.findMany({
        where: { grants: { some: { scope: { key: ADMIN_SCOPE_KEY } } } },
        select: { normalizedEmail: true },
      }),
      tx.user.findMany({ where: { emailVerified: true }, select: { email: true } }),
    ]);
    const verified = new Set(users.map(({ email }) => normalizeMutationEmail(email)));
    if (
      new Set(
        admins.map(({ normalizedEmail }) => normalizedEmail).filter((item) => verified.has(item)),
      ).size <= 1
    )
      throw new PrimitiveMutationError("LAST_ADMIN", "The last administrator cannot be removed.");
  }
  if (!current && !keys.length) return null;
  if (current && !keys.length) {
    const write = await tx.emailScopeAssignment.deleteMany({
      where: { id: current.id, version: current.version },
    });
    if (write.count !== 1) conflict("assignment");
    await basicAudit(tx, actor, "user_scopes.deleted", "email_scope_assignment", current.id, {
      normalizedEmail: email,
      beforeScopes: before,
      afterScopes: [],
      addedScopes: [],
      removedScopes: before,
      source: actor.source,
      versionBefore: current.version,
      versionAfter: current.version + 1,
    });
    // Return the deleted identity for browser mutation responses. Any IaC
    // binding is now a tombstone until intentional reconciliation removes it.
    return { ...current, grants: [], version: current.version + 1 };
  }
  let saved;
  if (current) {
    await tx.emailScopeGrant.deleteMany({ where: { assignmentId: current.id } });
    if (scopes.length)
      await tx.emailScopeGrant.createMany({
        data: scopes.map((scope) => ({
          id: randomUUID(),
          assignmentId: current.id,
          scopeId: scope.id,
          createdBy: actor.id,
        })),
      });
    const write = await tx.emailScopeAssignment.updateMany({
      where: { id: current.id, version: current.version },
      data: { version: { increment: 1 }, updatedBy: actor.id },
    });
    if (write.count !== 1) conflict("assignment");
    saved = await tx.emailScopeAssignment.findUniqueOrThrow({
      where: { id: current.id },
      include: emailInclude,
    });
  } else {
    saved = await tx.emailScopeAssignment.create({
      data: {
        normalizedEmail: email,
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: {
          create: scopes.map((scope) => ({
            id: randomUUID(),
            scopeId: scope.id,
            createdBy: actor.id,
          })),
        },
      },
      include: emailInclude,
    });
  }
  const after = saved.grants.map(({ scope }: any) => scope.key).sort();
  await basicAudit(
    tx,
    actor,
    before.length
      ? after.length
        ? "user_scopes.replaced"
        : "user_scopes.deleted"
      : "user_scopes.created",
    "email_scope_assignment",
    saved.id,
    {
      normalizedEmail: email,
      beforeScopes: before,
      afterScopes: after,
      addedScopes: after.filter((key: string) => !before.includes(key)),
      removedScopes: before.filter((key) => !after.includes(key)),
      source: actor.source,
      versionBefore: current?.version ?? 0,
      versionAfter: saved.version,
    },
  );
  return saved;
}

export async function preflightGroupAssignment(
  providerKey: string,
  groupId: string,
): Promise<GroupAssignmentPreflight> {
  const provider = await (
    await import("@weldall/db")
  ).db.groupProvider.findUnique({ where: { key: providerKey } });
  if (!provider)
    throw new PrimitiveMutationError("INVALID_PROVIDER", `Provider ${providerKey} was not found.`);
  if (!provider.enabled)
    throw new PrimitiveMutationError("INVALID_PROVIDER", `Provider ${providerKey} is disabled.`);
  let groups;
  try {
    groups = await createGroupProviderAdapter({
      adapterType: z.literal("management-api-v1").parse(provider.adapterType),
      baseUrl: provider.baseUrl,
      token: decryptProviderToken(provider),
    }).getGroups([groupId]);
  } catch {
    throw new PrimitiveMutationError(
      "INVALID_PROVIDER",
      `Could not validate provider group ${groupId}.`,
    );
  }
  const group = groups.find((item) => item.id === groupId);
  if (!group)
    throw new PrimitiveMutationError("INVALID_GROUP", `Provider group ${groupId} was not found.`);
  return {
    providerId: provider.id,
    providerKey: provider.key,
    providerVersion: provider.version,
    providerEnabled: provider.enabled,
    groupId,
    groupName: group.name,
  };
}

export async function mutateGroupAssignment(
  tx: Prisma.TransactionClient,
  input:
    | {
        action: "create";
        providerKey: string;
        groupId: string;
        scopeKeys: string[];
        preflight: GroupAssignmentPreflight;
      }
    | { action: "update"; id: string; scopeKeys: string[]; expectedVersion: number }
    | { action: "delete"; id: string; expectedVersion: number },
  actor: MutationActor,
): Promise<any> {
  if (input.action === "create") {
    const keys = parseScopeKeys(input.scopeKeys, true);
    const provider = await tx.groupProvider.findUnique({
      where: { id: input.preflight.providerId },
    });
    if (!provider?.enabled)
      throw new PrimitiveMutationError("INVALID_PROVIDER", "The group provider is unavailable.");
    if (provider.key !== input.providerKey || provider.version !== input.preflight.providerVersion)
      throw new PrimitiveMutationError(
        "CONFLICT",
        "The group provider changed during validation. Reload and try again.",
      );
    const scopes = await scopesByKeys(tx, keys);
    const duplicate = await tx.groupScopeAssignment.findUnique({
      where: { providerId_groupId: { providerId: provider.id, groupId: input.groupId } },
    });
    if (duplicate)
      throw new PrimitiveMutationError(
        "CONFLICT",
        `Provider group ${input.groupId} already has an assignment.`,
      );
    const saved = await tx.groupScopeAssignment.create({
      data: {
        providerId: provider.id,
        groupId: input.groupId,
        groupName: input.preflight.groupName,
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: { create: scopes.map((scope) => ({ scopeId: scope.id, createdBy: actor.id })) },
      },
      include: groupInclude,
    });
    await groupAudit(tx, actor, "group_scopes.created", saved, [], keys, 0, saved.version);
    return saved;
  }
  const current = await tx.groupScopeAssignment.findUnique({
    where: { id: input.id },
    include: groupInclude,
  });
  if (!current) throw new PrimitiveMutationError("NOT_FOUND", "Group assignment not found.");
  assertVersion(current.version, input.expectedVersion, "group assignment");
  const before = current.grants.map(({ scope }) => scope.key).sort();
  if (input.action === "delete") {
    const write = await tx.groupScopeAssignment.deleteMany({
      where: { id: current.id, version: input.expectedVersion },
    });
    if (write.count !== 1) conflict("group assignment");
    await groupAudit(
      tx,
      actor,
      "group_scopes.deleted",
      current,
      before,
      [],
      current.version,
      current.version + 1,
    );
    return { id: current.id };
  }
  const keys = parseScopeKeys(input.scopeKeys, true);
  if (same(before, keys)) return current;
  const scopes = await scopesByKeys(tx, keys);
  await tx.groupScopeGrant.deleteMany({ where: { assignmentId: current.id } });
  await tx.groupScopeGrant.createMany({
    data: scopes.map((scope) => ({
      assignmentId: current.id,
      scopeId: scope.id,
      createdBy: actor.id,
    })),
  });
  const write = await tx.groupScopeAssignment.updateMany({
    where: { id: current.id, version: input.expectedVersion },
    data: { version: { increment: 1 }, updatedBy: actor.id },
  });
  if (write.count !== 1) conflict("group assignment");
  const saved = await tx.groupScopeAssignment.findUniqueOrThrow({
    where: { id: current.id },
    include: groupInclude,
  });
  await groupAudit(
    tx,
    actor,
    "group_scopes.replaced",
    saved,
    before,
    keys,
    current.version,
    saved.version,
  );
  return saved;
}

export async function reconcileMachine(
  tx: Prisma.TransactionClient,
  input: {
    id?: string;
    clientId: string;
    name: string;
    enabled: boolean;
    resourceKeys: string[];
    scopeKeys: string[];
    publicKeys: Record<string, JWK>;
    expectedVersion: number | null;
  },
  actor: MutationActor,
): Promise<any> {
  const clientId = parseClientId(input.clientId);
  const name = input.name.trim();
  if (!name || name.length > 200)
    throw new PrimitiveMutationError(
      "INVALID_RESOURCE",
      "Machine names must contain 1 to 200 characters.",
    );
  const current = input.id
    ? await tx.machineClient.findUnique({ where: { id: input.id }, include: machineInclude })
    : null;
  if (input.expectedVersion === null) {
    if (current || (await tx.machineClient.findUnique({ where: { clientId } })))
      conflict("machine client");
  } else if (!current || current.version !== input.expectedVersion) {
    conflict("machine client");
  }
  const [scopes, resources] = await Promise.all([
    scopesByKeys(tx, parseScopeKeys(input.scopeKeys)),
    tx.downstreamResource.findMany({ where: { key: { in: input.resourceKeys } } }),
  ]);
  if (resources.length !== input.resourceKeys.length)
    throw new PrimitiveMutationError("INVALID_RESOURCE", "Choose registered resources.");
  if (
    resources.some(
      (resource) =>
        !resource.enabled &&
        !current?.allowedResources.some(({ resourceId }) => resourceId === resource.id),
    )
  )
    throw new PrimitiveMutationError("INVALID_RESOURCE", "Choose enabled resources.");
  const parsedKeys = new Map<string, { publicJwk: JWK; thumbprint: string }>();
  for (const [kid, raw] of Object.entries(input.publicKeys))
    parsedKeys.set(kid, await parsePublicKey(kid, raw));
  let machine = current;
  if (!machine) {
    machine = await tx.machineClient.create({
      data: {
        clientId,
        name,
        enabled: input.enabled,
        deactivatedAt: input.enabled ? null : new Date(),
        createdBy: actor.id,
        updatedBy: actor.id,
      },
      include: machineInclude,
    });
    await machineAudit(tx, actor, "machine_client.created", machine);
  } else if (machine.name !== name || machine.enabled !== input.enabled) {
    const write = await tx.machineClient.updateMany({
      where: { id: machine.id, version: machine.version },
      data: {
        name,
        enabled: input.enabled,
        deactivatedAt: input.enabled ? null : (machine.deactivatedAt ?? new Date()),
        version: { increment: 1 },
        updatedBy: actor.id,
      },
    });
    if (write.count !== 1) conflict("machine client");
    machine = await tx.machineClient.findUniqueOrThrow({
      where: { id: machine.id },
      include: machineInclude,
    });
    await machineAudit(
      tx,
      actor,
      input.enabled ? "machine_client.updated" : "machine_client.deactivated",
      machine,
    );
  }
  for (const [kid, key] of parsedKeys) {
    const prior = machine.keys.find((item) => item.kid === kid);
    if (prior?.revokedAt)
      throw new PrimitiveMutationError("CONFLICT", `Revoked key ${kid} cannot be reactivated.`);
    if (prior && prior.thumbprint !== key.thumbprint)
      throw new PrimitiveMutationError("CONFLICT", `Key ID ${kid} is immutable.`);
    if (!prior) {
      const created = await tx.machineClientKey.create({
        data: {
          machineClientId: machine.id,
          kid,
          publicJwk: key.publicJwk as Prisma.InputJsonObject,
          thumbprint: key.thumbprint,
          createdBy: actor.id,
        },
      });
      await keyAudit(tx, actor, "machine_key.registered", machine, created);
    }
  }
  for (const prior of machine.keys)
    if (!prior.revokedAt && !parsedKeys.has(prior.kid)) {
      const revoked = await tx.machineClientKey.update({
        where: { id: prior.id },
        data: { revokedAt: new Date(), revokedBy: actor.id },
      });
      await keyAudit(tx, actor, "machine_key.revoked", machine, revoked);
    }
  const beforeResources = machine.allowedResources
    .map(({ resource }) => resource.resourceIdentifier)
    .sort();
  const beforeScopes = machine.allowedScopes.map(({ scope }) => scope.key).sort();
  const afterResources = resources.map(({ resourceIdentifier }) => resourceIdentifier).sort();
  const afterScopes = scopes.map(({ key }) => key).sort();
  if (!same(beforeResources, afterResources) || !same(beforeScopes, afterScopes)) {
    const versionBefore = machine.version;
    const write = await tx.machineClient.updateMany({
      where: { id: machine.id, version: versionBefore },
      data: { version: { increment: 1 }, updatedBy: actor.id },
    });
    if (write.count !== 1) conflict("machine access");
    await tx.machineAllowedResource.deleteMany({ where: { machineClientId: machine.id } });
    await tx.machineAllowedScope.deleteMany({ where: { machineClientId: machine.id } });
    if (resources.length)
      await tx.machineAllowedResource.createMany({
        data: resources.map(({ id }) => ({ machineClientId: machine!.id, resourceId: id })),
      });
    if (scopes.length)
      await tx.machineAllowedScope.createMany({
        data: scopes.map(({ id }) => ({ machineClientId: machine!.id, scopeId: id })),
      });
    machine = await tx.machineClient.findUniqueOrThrow({
      where: { id: machine.id },
      include: machineInclude,
    });
    await basicAudit(tx, actor, "machine_access.replaced", "machine_client", machine.id, {
      clientId: machine.clientId,
      beforeResources,
      afterResources,
      beforeScopes,
      afterScopes,
      versionBefore,
      versionAfter: machine.version,
      source: actor.source,
    });
  }
  return tx.machineClient.findUniqueOrThrow({ where: { id: machine.id }, include: machineInclude });
}

export async function deleteMachine(
  tx: Prisma.TransactionClient,
  input: { id: string; expectedVersion: number },
  actor: MutationActor,
) {
  const current = await tx.machineClient.findUnique({ where: { id: input.id } });
  if (!current) throw new PrimitiveMutationError("NOT_FOUND", "Machine client not found.");
  assertVersion(current.version, input.expectedVersion, "machine client");
  const deleted = await tx.machineClient.deleteMany({
    where: { id: current.id, version: input.expectedVersion },
  });
  if (deleted.count !== 1) conflict("machine client");
  await machineAudit(tx, actor, "machine_client.deleted", current);
  return { id: current.id };
}

function parseResource(input: ResourceMutableInput, create: boolean) {
  const name = input.name.trim();
  const downstreamClientId = input.downstreamClientId.trim();
  if (!name || name.length > 200 || !downstreamClientId || downstreamClientId.length > 200)
    throw new PrimitiveMutationError(
      "INVALID_RESOURCE",
      "Resource name and downstream client ID are required.",
    );
  try {
    if (create) normalizeResourceIdentifier((input as any).resourceIdentifier);
    const authorizationServer = normalizeAuthorizationServer(input.authorizationServer);
    const requestPrefixes = input.requestPrefixes.map(normalizeRequestPrefix).sort();
    if (
      !requestPrefixes.length ||
      requestPrefixes.length > 100 ||
      new Set(requestPrefixes).size !== requestPrefixes.length
    )
      throw new Error("A resource must have between 1 and 100 unique request prefixes.");
    return {
      ...input,
      name,
      downstreamClientId,
      authorizationServer,
      requestPrefixes,
      scopeKeys: parseScopeKeys(input.scopeKeys),
    };
  } catch (error) {
    throw new PrimitiveMutationError(
      "INVALID_RESOURCE",
      error instanceof Error ? error.message : "Invalid resource URL.",
    );
  }
}
function parseScopeKey(value: string): string {
  const parsed = scopeKeySchema.safeParse(value);
  if (!parsed.success)
    throw new PrimitiveMutationError(
      "INVALID_SCOPE",
      "Scope keys must be lowercase namespace:permission values.",
    );
  return parsed.data as string;
}
function parseDescription(value: string) {
  const result = value.trim();
  if (!result || result.length > 500)
    throw new PrimitiveMutationError(
      "INVALID_SCOPE",
      "Scope descriptions must contain 1 to 500 characters.",
    );
  return result;
}
function parseScopeKeys(values: string[], human = false) {
  const keys = [...new Set(values.map(parseScopeKey))].sort();
  if (keys.length > 100 || (human && !keys.length))
    throw new PrimitiveMutationError(
      "INVALID_SCOPE",
      human ? "Choose between 1 and 100 scopes." : "At most 100 scopes may be selected.",
    );
  if (human && keys.includes(IAC_SCOPE_KEY))
    throw new PrimitiveMutationError("SYSTEM_SCOPE", `${IAC_SCOPE_KEY} is machine-only.`);
  return keys;
}
async function scopesByKeys(tx: Prisma.TransactionClient, keys: string[]) {
  const rows = await tx.scope.findMany({ where: { key: { in: keys } } });
  if (rows.length !== keys.length) {
    const known = new Set(rows.map(({ key }) => key));
    throw new PrimitiveMutationError("INVALID_SCOPE", "One or more scopes do not exist.", {
      unknownScopes: keys.filter((key) => !known.has(key)),
    });
  }
  return rows;
}
async function assertPrefixes(
  tx: Prisma.TransactionClient,
  prefixes: string[],
  resourceId?: string,
  resourceKey?: string,
) {
  const existing = await tx.resourceRequestPrefix.findMany({
    ...(resourceId ? { where: { resourceId: { not: resourceId } } } : {}),
    include: { resource: { select: { key: true } } },
  });
  for (const prefix of prefixes) {
    const hit = existing.find(
      (item) => item.resource.key !== resourceKey && requestPrefixesOverlap(prefix, item.urlPrefix),
    );
    if (hit)
      throw new PrimitiveMutationError(
        "CONFLICT",
        `Request prefix ${prefix} overlaps resource ${hit.resource.key}.`,
      );
  }
}
function assertVersion(current: number, expected: number, label: string) {
  if (current !== expected)
    throw new PrimitiveMutationError("CONFLICT", `The ${label} changed. Reload and try again.`, {
      currentVersion: current,
    });
}
function conflict(label: string): never {
  throw new PrimitiveMutationError("CONFLICT", `The ${label} changed. Reload and try again.`);
}
function same(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function parseClientId(value: string) {
  const id = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || id === "weldall-cli")
    throw new PrimitiveMutationError("INVALID_RESOURCE", "Enter a safe, unique machine client ID.");
  return id;
}
async function parsePublicKey(kidValue: string, raw: unknown) {
  const kid = kidValue.trim();
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(kid) ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    "d" in raw
  )
    throw new PrimitiveMutationError(
      "INVALID_RESOURCE",
      "Enter a public ES256 JWK object without private material.",
    );
  const candidate = structuredClone(raw) as JWK;
  try {
    await assertPublicP256(candidate);
  } catch {
    throw new PrimitiveMutationError("INVALID_RESOURCE", "Enter a valid public ES256 P-256 JWK.");
  }
  const publicJwk: JWK = {
    kty: "EC",
    crv: "P-256",
    x: candidate.x!,
    y: candidate.y!,
    alg: "ES256",
    use: "sig",
  };
  return { publicJwk, thumbprint: await calculateJwkThumbprint(publicJwk, "sha256") };
}

async function basicAudit(
  tx: Prisma.TransactionClient,
  actor: MutationActor,
  eventType: AuditEventType,
  subjectType: string,
  subjectId: string,
  metadata: unknown,
) {
  await prismaAuditWriter.write(
    {
      eventType,
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      ...(actor.type === "machine" ? { clientId: actor.id } : {}),
      requestId: actor.requestId,
      ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
      outcome: "success",
      subjectType,
      subjectId,
      metadata,
    },
    tx,
  );
}
function contentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function scopeAudit(
  tx: Prisma.TransactionClient,
  actor: MutationActor,
  eventType: "resource_scopes.created" | "resource_scopes.replaced" | "resource_scopes.deleted",
  before: any,
  after: any,
) {
  const snapshot = (item: any) => ({
    key: item.key,
    description: item.description,
    isSystem: item.isSystem,
    version: item.version,
  });
  const b = before ? snapshot(before) : null;
  const a = after ? snapshot(after) : null;
  const item = after ?? before;
  await basicAudit(tx, actor, eventType, "scope_definition", item.id, {
    entityType: "scope_definition",
    source: actor.source,
    resourceIdentifier: null,
    before: b,
    after: a,
    addedScopes: before ? [] : [item.key],
    changedScopes: before && after ? [item.key] : [],
    removedScopes: after ? [] : [item.key],
    contentDigest: contentHash(a ?? b),
  });
}
async function resourceAudit(
  tx: Prisma.TransactionClient,
  actor: MutationActor,
  eventType: "resource_scopes.created" | "resource_scopes.replaced" | "resource_scopes.deleted",
  before: any,
  after: any,
) {
  const snapshot = (item: any) => ({
    key: item.key,
    resourceIdentifier: item.resourceIdentifier,
    authorizationServer: item.authorizationServer,
    downstreamClientId: item.downstreamClientId,
    scopeKeys: item.scopes.map(({ scope }: any) => scope.key).sort(),
    requestPrefixes: item.requestPrefixes.map(({ urlPrefix }: any) => urlPrefix).sort(),
    enabled: item.enabled,
    skillDiscoveryEnabled: item.skillDiscoveryEnabled,
    ownerId: item.createdBy,
    version: item.version,
  });
  const b = before ? snapshot(before) : null;
  const a = after ? snapshot(after) : null;
  const item = after ?? before;
  const beforeScopes = b?.scopeKeys ?? [];
  const afterScopes = a?.scopeKeys ?? [];
  await basicAudit(tx, actor, eventType, "downstream_resource", item.id, {
    entityType: "registered_resource",
    source: actor.source,
    resourceIdentifier: item.resourceIdentifier,
    before: b,
    after: a,
    addedScopes: afterScopes.filter((key: string) => !beforeScopes.includes(key)),
    changedScopes: [],
    removedScopes: beforeScopes.filter((key: string) => !afterScopes.includes(key)),
    contentDigest: contentHash(a ?? b),
  });
}
async function groupAudit(
  tx: Prisma.TransactionClient,
  actor: MutationActor,
  eventType: "group_scopes.created" | "group_scopes.replaced" | "group_scopes.deleted",
  assignment: any,
  beforeScopes: string[],
  afterScopes: string[],
  versionBefore: number,
  versionAfter: number,
) {
  await basicAudit(tx, actor, eventType, "group_scope_assignment", assignment.id, {
    providerId: assignment.providerId,
    providerKey: assignment.provider.key,
    groupId: assignment.groupId,
    groupName: assignment.groupName,
    beforeScopes,
    afterScopes,
    addedScopes: afterScopes.filter((key) => !beforeScopes.includes(key)),
    removedScopes: beforeScopes.filter((key) => !afterScopes.includes(key)),
    source: actor.source,
    versionBefore,
    versionAfter,
  });
}
async function machineAudit(
  tx: Prisma.TransactionClient,
  actor: MutationActor,
  eventType:
    | "machine_client.created"
    | "machine_client.updated"
    | "machine_client.deactivated"
    | "machine_client.deleted",
  machine: any,
) {
  await basicAudit(tx, actor, eventType, "machine_client", machine.id, {
    clientId: machine.clientId,
    name: machine.name,
    enabled: machine.enabled,
    version: machine.version,
    source: actor.source,
  });
}
async function keyAudit(
  tx: Prisma.TransactionClient,
  actor: MutationActor,
  eventType: "machine_key.registered" | "machine_key.revoked",
  machine: any,
  key: any,
) {
  await basicAudit(tx, actor, eventType, "machine_key", key.id, {
    clientId: machine.clientId,
    kid: key.kid,
    thumbprint: key.thumbprint,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    source: actor.source,
  });
}
