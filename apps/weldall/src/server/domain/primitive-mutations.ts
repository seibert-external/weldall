import { createHash, randomUUID } from "node:crypto";
import { ADMIN_SCOPE_KEY, isMachineOnlySystemScope, Prisma } from "@weldall/db";
import {
  assertPublicP256,
  normalizeAuthorizationServer,
  normalizeRequestPrefix,
  normalizeResourceIdentifier,
  requestPrefixesOverlap,
  SKILL_TAG_LENGTH_LIMIT,
  SKILL_TAG_LIMIT,
} from "@weldall/sdk";
import { calculateJwkThumbprint, type JWK } from "jose";
import { z } from "zod";
import { prismaAuditWriter, type AuditEventType } from "../audit/service";
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
      | "INVALID_SKILL"
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
const skillInclude = {
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

export type SkillMetaInput = {
  tags?: string[] | undefined;
  owner?: string | undefined;
  appearance?: Record<string, string> | undefined;
};

export type SkillMutableInput = {
  title: string;
  content: string;
  requiredScopes: string[];
  visibility: "DEFAULT" | "HIDDEN_IF_UNALLOWED";
  meta?: SkillMetaInput | undefined;
  lastUpdatedAt?: string | undefined;
};

export async function mutateSkill(
  tx: Prisma.TransactionClient,
  input:
    | ({ action: "create"; slug: string } & SkillMutableInput)
    | ({ action: "update"; id: string; expectedVersion: number } & SkillMutableInput)
    | { action: "delete"; id: string; expectedVersion: number },
  actor: MutationActor,
): Promise<any> {
  if (input.action === "delete") {
    const current = await tx.skill.findUnique({ where: { id: input.id }, include: skillInclude });
    if (!current) throw new PrimitiveMutationError("NOT_FOUND", "Skill not found.");
    assertVersion(current.version, input.expectedVersion, "skill");
    const deleted = await tx.skill.deleteMany({
      where: { id: current.id, version: input.expectedVersion },
    });
    if (deleted.count !== 1) conflict("skill");
    await skillAudit(tx, actor, "skill.deleted", current, null);
    return { id: current.id };
  }

  const parsed = parseSkill(input, input.action === "create");
  const current =
    input.action === "update"
      ? await tx.skill.findUnique({ where: { id: input.id }, include: skillInclude })
      : null;
  if (input.action === "update") {
    if (!current) throw new PrimitiveMutationError("NOT_FOUND", "Skill not found.");
    assertVersion(current.version, input.expectedVersion, "skill");
  }
  await scopesByKeys(tx, parsed.requiredScopes);
  if (!current) {
    const slug = (input as { slug: string }).slug.trim();
    if (await tx.skill.findUnique({ where: { slug }, select: { id: true } }))
      throw new PrimitiveMutationError("CONFLICT", `Skill ${slug} already exists.`);
    const created = await tx.skill.create({
      data: {
        slug,
        ...skillMutationData(parsed),
        createdBy: actor.id,
        updatedBy: actor.id,
      },
      include: skillInclude,
    });
    await skillAudit(tx, actor, "skill.created", null, created);
    return created;
  }
  if (input.action !== "update") throw new Error("Unexpected skill mutation action");
  if (
    current.title === parsed.title &&
    current.content === parsed.content &&
    current.visibility === parsed.visibility &&
    same([...current.requiredScopes].sort(), parsed.requiredScopes) &&
    JSON.stringify(skillMetaFromStoredValue(current.meta)) === JSON.stringify(parsed.meta) &&
    (current.lastUpdatedAt ?? undefined) === parsed.lastUpdatedAt
  )
    return current;
  const write = await tx.skill.updateMany({
    where: { id: current.id, version: input.expectedVersion },
    data: {
      ...skillMutationData(parsed),
      version: { increment: 1 },
      updatedBy: actor.id,
    },
  });
  if (write.count !== 1) conflict("skill");
  const updated = await tx.skill.findUniqueOrThrow({
    where: { id: current.id },
    include: skillInclude,
  });
  await skillAudit(tx, actor, "skill.updated", current, updated);
  return updated;
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
  const machineOnlyScope = keys.find(isMachineOnlySystemScope);
  if (machineOnlyScope)
    throw new PrimitiveMutationError("SYSTEM_SCOPE", `${machineOnlyScope} is machine-only.`);
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

export async function mutateGroupAssignment(
  tx: Prisma.TransactionClient,
  input:
    | { action: "create"; providerKey: string; groupId: string; scopeKeys: string[] }
    | { action: "update"; id: string; scopeKeys: string[]; expectedVersion: number }
    | { action: "delete"; id: string; expectedVersion: number },
  actor: MutationActor,
): Promise<any> {
  if (input.action === "create") {
    const keys = parseScopeKeys(input.scopeKeys, true);
    const groupId = z.string().trim().min(1).max(191).parse(input.groupId);
    const provider = await tx.groupProvider.findUnique({ where: { key: input.providerKey } });
    if (!provider)
      throw new PrimitiveMutationError(
        "INVALID_PROVIDER",
        `Provider ${input.providerKey} was not found.`,
      );
    const scopes = await scopesByKeys(tx, keys);
    const duplicate = await tx.groupScopeAssignment.findUnique({
      where: { providerId_groupId: { providerId: provider.id, groupId } },
    });
    if (duplicate)
      throw new PrimitiveMutationError(
        "CONFLICT",
        `Provider group ${groupId} already has an assignment.`,
      );
    const saved = await tx.groupScopeAssignment.create({
      data: {
        providerId: provider.id,
        groupId,
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

function parseSkill(input: SkillMutableInput & { slug?: string }, create: boolean) {
  const slug = input.slug?.trim();
  const title = input.title.trim();
  const content = input.content.trim();
  if (create && (!slug || slug.length > 120 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(slug)))
    throw new PrimitiveMutationError(
      "INVALID_SKILL",
      "Skill IDs must use lowercase letters, numbers, dots, dashes, or underscores.",
    );
  if (!title || title.length > 200)
    throw new PrimitiveMutationError(
      "INVALID_SKILL",
      "Skill titles must contain 1 to 200 characters.",
    );
  if (!content || content.length > 100_000)
    throw new PrimitiveMutationError(
      "INVALID_SKILL",
      "Skill Markdown must contain 1 to 100,000 characters.",
    );
  if (input.visibility !== "DEFAULT" && input.visibility !== "HIDDEN_IF_UNALLOWED")
    throw new PrimitiveMutationError("INVALID_SKILL", "Skill visibility is invalid.");
  const requiredScopes = parseScopeKeys(input.requiredScopes);
  if (
    input.meta !== undefined &&
    ((input.meta.tags !== undefined &&
      (!Array.isArray(input.meta.tags) ||
        input.meta.tags.length > SKILL_TAG_LIMIT ||
        !input.meta.tags.every(
          (tag) =>
            typeof tag === "string" && tag.length > 0 && tag.length <= SKILL_TAG_LENGTH_LIMIT,
        ))) ||
      (input.meta.owner !== undefined && typeof input.meta.owner !== "string") ||
      (input.meta.appearance !== undefined &&
        (!input.meta.appearance ||
          typeof input.meta.appearance !== "object" ||
          Array.isArray(input.meta.appearance) ||
          !Object.values(input.meta.appearance).every((value) => typeof value === "string"))))
  )
    throw new PrimitiveMutationError("INVALID_SKILL", "Skill meta is invalid.");
  if (input.lastUpdatedAt !== undefined && typeof input.lastUpdatedAt !== "string")
    throw new PrimitiveMutationError("INVALID_SKILL", "Skill lastUpdatedAt is invalid.");
  return {
    title,
    content,
    requiredScopes,
    visibility: input.visibility,
    ...(input.meta !== undefined
      ? {
          meta: {
            ...(input.meta.tags !== undefined ? { tags: [...input.meta.tags] } : {}),
            ...(input.meta.owner !== undefined ? { owner: input.meta.owner } : {}),
            ...(input.meta.appearance !== undefined
              ? { appearance: { ...input.meta.appearance } }
              : {}),
          },
        }
      : {}),
    ...(input.lastUpdatedAt !== undefined ? { lastUpdatedAt: input.lastUpdatedAt } : {}),
  };
}

function skillMetaFromStoredValue(value: unknown): SkillMetaInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.tags !== undefined &&
      (!Array.isArray(candidate.tags) ||
        !candidate.tags.every((tag) => typeof tag === "string"))) ||
    (candidate.owner !== undefined && typeof candidate.owner !== "string") ||
    (candidate.appearance !== undefined &&
      (!candidate.appearance ||
        typeof candidate.appearance !== "object" ||
        Array.isArray(candidate.appearance) ||
        !Object.values(candidate.appearance).every((entry) => typeof entry === "string")))
  )
    return undefined;
  return {
    ...(candidate.tags !== undefined ? { tags: candidate.tags as string[] } : {}),
    ...(candidate.owner !== undefined ? { owner: candidate.owner } : {}),
    ...(candidate.appearance !== undefined
      ? { appearance: candidate.appearance as Record<string, string> }
      : {}),
  };
}

function skillMutationData(parsed: ReturnType<typeof parseSkill>) {
  return {
    title: parsed.title,
    content: parsed.content,
    requiredScopes: parsed.requiredScopes,
    visibility: parsed.visibility,
    meta: parsed.meta === undefined ? Prisma.DbNull : parsed.meta,
    lastUpdatedAt: parsed.lastUpdatedAt ?? null,
  };
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
  const machineOnlyScope = human ? keys.find(isMachineOnlySystemScope) : undefined;
  if (machineOnlyScope)
    throw new PrimitiveMutationError("SYSTEM_SCOPE", `${machineOnlyScope} is machine-only.`);
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
async function skillAudit(
  tx: Prisma.TransactionClient,
  actor: MutationActor,
  eventType: "skill.created" | "skill.updated" | "skill.deleted",
  before: any,
  after: any,
) {
  const snapshot = (item: any) => ({
    title: item.title,
    requiredScopes: [...item.requiredScopes].sort(),
    visibility: item.visibility,
    meta: item.meta,
    lastUpdatedAt: item.lastUpdatedAt,
    contentSha256: createHash("sha256").update(item.content).digest("hex"),
    version: item.version,
  });
  const metadata =
    eventType === "skill.updated"
      ? { slug: before.slug, before: snapshot(before), after: snapshot(after) }
      : { slug: (after ?? before).slug, ...snapshot(after ?? before) };
  await basicAudit(tx, actor, eventType, "skill", (after ?? before).id, metadata);
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
