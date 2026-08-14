import { createHash, randomUUID } from "node:crypto";
import { ADMIN_SCOPE_KEY, db, IAC_SCOPE_KEY, LOGIN_SCOPE_KEY, Prisma } from "@weldall/db";
import {
  normalizeAuthorizationServer,
  normalizeRequestPrefix,
  normalizeResourceIdentifier,
} from "@weldall/sdk";
import { z } from "zod";
import { listAuditEvents, prismaAuditWriter, type AuditEventType } from "../audit/service";
import {
  lockConfigurationChanges,
  lockSkillScopeChanges as lockAllSkillScopeChanges,
  managementBindingInclude,
  managementMetadata,
  type ManagementMetadata,
} from "../domain/configuration";
import {
  mutateEmailAssignment,
  mutateResource,
  mutateScope,
  mutateSkill,
  PrimitiveMutationError,
  type MutationActor,
} from "../domain/primitive-mutations";
import { hasEffectiveSystemScopeFor } from "../policy/resources";
import { scopeKeySchema, type ScopeKey } from "../policy/scope-key";

export { ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY } from "@weldall/db";
export const MAX_ASSIGNMENT_SCOPES = 100;
export const MAX_PAGE_SIZE = 100;

const resourceKeyPattern = /^[a-z0-9._-]+$/;
const emailSchema = z.string().email().max(320);
const resourceInclude = {
  scopes: { include: { scope: { select: { id: true, key: true } } } },
  requestPrefixes: { orderBy: { urlPrefix: "asc" as const } },
  discoveredCatalog: { include: { _count: { select: { skills: true } } } },
  iacBinding: managementBindingInclude,
} as const;
const scopeInclude = {
  _count: { select: { grants: true, groupGrants: true } },
  iacBinding: managementBindingInclude,
} as const;
const assignmentInclude = {
  grants: { include: { scope: { select: { key: true } } } },
  iacBinding: managementBindingInclude,
} as const;
const skillInclude = { iacBinding: managementBindingInclude } as const;

export type AdminErrorCode =
  | "CONFLICT"
  | "FORBIDDEN"
  | "INVALID_CLI_SETTINGS"
  | "INVALID_EMAIL"
  | "INVALID_RESOURCE"
  | "INVALID_PROVIDER"
  | "INVALID_GROUP"
  | "INVALID_SCOPE"
  | "INVALID_SKILL"
  | "LAST_ADMIN"
  | "NOT_FOUND"
  | "SYSTEM_SCOPE";

export class AdminDomainError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdminDomainError";
  }
}

export interface AdminActor {
  id: string;
  email?: string | null;
  requestId: string;
  correlationId?: string;
}

export interface UserDto {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export type ManagementDto = ManagementMetadata;

export interface ScopeDto {
  id: string;
  key: string;
  description: string;
  isSystem: boolean;
  version: number;
  assignmentCount: number;
  createdAt: string;
  updatedAt: string;
  management: ManagementDto;
}

export interface AssignmentDto {
  id: string;
  email: string;
  scopes: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  management: ManagementDto;
}

export type SkillVisibilityDto = "DEFAULT" | "HIDDEN_IF_UNALLOWED";

export interface SkillSourceOptionDto {
  id: string;
  name: string;
}

export interface SkillDto {
  id: string;
  slug: string;
  title: string;
  content: string;
  requiredScopes: string[];
  visibility: SkillVisibilityDto;
  version: number;
  createdAt: string;
  updatedAt: string;
  source:
    | { type: "manual" }
    | {
        type: "resource";
        resourceId: string;
        key: string;
        name: string;
        catalogState: "disabled" | "pending" | "fresh" | "stale" | "expired" | "failed";
      };
  readOnly: boolean;
  disabled: boolean;
  scopeWarnings: string[];
  overridden: boolean;
  management: ManagementDto;
}

export interface CliSettingsDto {
  appendix: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceDto {
  id: string;
  key: string;
  name: string;
  resourceIdentifier: string;
  authorizationServer: string;
  downstreamClientId: string;
  enabled: boolean;
  skillDiscoveryEnabled: boolean;
  catalogStatus: {
    state: "disabled" | "pending" | "fresh" | "stale" | "expired" | "failed";
    skillCount: number;
    lastAttemptAt: string | null;
    lastSuccessfulRefreshAt: string | null;
    lastFailureCategory: string | null;
    lastFailureAt: string | null;
  } | null;
  version: number;
  scopeIds: string[];
  scopeKeys: string[];
  requestPrefixes: string[];
  createdAt: string;
  updatedAt: string;
  management: ManagementDto;
}

export function normalizeEmail(rawEmail: string): string {
  const normalized = rawEmail.trim().toLowerCase();
  if (!emailSchema.safeParse(normalized).success) {
    throw new AdminDomainError("INVALID_EMAIL", "Enter a valid email address.");
  }
  return normalized;
}

export function parseScopeKey(rawKey: string): ScopeKey {
  const parsed = scopeKeySchema.safeParse(rawKey);
  if (!parsed.success) {
    throw new AdminDomainError(
      "INVALID_SCOPE",
      "Scope keys must be lowercase namespace:permission values.",
    );
  }
  return parsed.data;
}

export function parseScopeDescription(rawDescription: string): string {
  const description = rawDescription.trim();
  if (description.length < 1 || description.length > 500) {
    throw new AdminDomainError(
      "INVALID_SCOPE",
      "Scope descriptions must contain 1 to 500 characters.",
    );
  }
  return description;
}

export async function isAdminEmail(email: string): Promise<boolean> {
  let normalizedEmail: string;
  try {
    normalizedEmail = normalizeEmail(email);
  } catch {
    return false;
  }

  return hasEffectiveSystemScopeFor(normalizedEmail, ADMIN_SCOPE_KEY);
}

export async function requireAdminUser(userId: string): Promise<{
  id: string;
  email: string;
}> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user?.emailVerified || !(await isAdminEmail(user.email))) {
    throw new AdminDomainError("FORBIDDEN", "Administrator access is required.");
  }
  return { id: user.id, email: user.email };
}

export async function listUsers(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  sort?:
    | "name.asc"
    | "name.desc"
    | "email.asc"
    | "email.desc"
    | "createdAt.asc"
    | "createdAt.desc"
    | undefined;
}): Promise<{ items: UserDto[]; total: number }> {
  const page = positiveInteger(input.page, 1);
  const pageSize = Math.min(positiveInteger(input.pageSize, 20), MAX_PAGE_SIZE);
  const q = input.q?.trim();
  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};
  const orderBy: Prisma.UserOrderByWithRelationInput[] =
    input.sort === "name.asc"
      ? [{ name: "asc" }, { id: "asc" }]
      : input.sort === "name.desc"
        ? [{ name: "desc" }, { id: "desc" }]
        : input.sort === "email.asc"
          ? [{ email: "asc" }, { id: "asc" }]
          : input.sort === "email.desc"
            ? [{ email: "desc" }, { id: "desc" }]
            : input.sort === "createdAt.asc"
              ? [{ createdAt: "asc" }, { id: "asc" }]
              : [{ createdAt: "desc" }, { id: "desc" }];
  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.user.count({ where }),
  ]);
  return { items: items.map(serializeUser), total };
}

export async function getUser(id: string): Promise<UserDto> {
  const user = await db.user.findUnique({ where: { id } });
  if (!user) throw new AdminDomainError("NOT_FOUND", "User not found.");
  return serializeUser(user);
}

export async function listUserAuditEvents(
  userId: string,
  input: {
    page: number;
    pageSize: number;
    from?: Date | undefined;
    to?: Date | undefined;
    eventType?: AuditEventType | undefined;
    outcome?: "success" | "denied" | "failed" | undefined;
    sort: "occurredAt.asc" | "occurredAt.desc";
  },
) {
  const user = await getUser(userId);
  const assignment = await db.emailScopeAssignment.findUnique({
    where: { normalizedEmail: normalizeEmail(user.email) },
    select: { id: true },
  });
  return listAuditEvents({
    ...input,
    relatedUser: {
      actorId: user.id,
      ...(assignment ? { assignmentId: assignment.id } : {}),
    },
  });
}

export async function getCliSettings(): Promise<CliSettingsDto> {
  const settings = await db.cliSettings.findUnique({
    where: { id: "default" },
  });
  if (!settings) throw new AdminDomainError("NOT_FOUND", "CLI settings are not initialized.");
  return serializeCliSettings(settings);
}

export async function updateCliSettings(
  input: { appendix: string; expectedVersion: number },
  actor: AdminActor,
): Promise<CliSettingsDto> {
  const appendix = input.appendix.trim();
  if (appendix.length > 100_000) {
    throw new AdminDomainError(
      "INVALID_CLI_SETTINGS",
      "The CLI appendix must contain at most 100,000 characters.",
    );
  }
  return db.$transaction(async (tx) => {
    const current = await tx.cliSettings.findUnique({
      where: { id: "default" },
    });
    if (!current) throw new AdminDomainError("NOT_FOUND", "CLI settings are not initialized.");
    assertVersion(current.version, input.expectedVersion);
    if (current.appendix === appendix) return serializeCliSettings(current);
    const write = await tx.cliSettings.updateMany({
      where: { id: current.id, version: input.expectedVersion },
      data: { appendix, version: { increment: 1 }, updatedBy: actor.id },
    });
    if (write.count !== 1) {
      throw new AdminDomainError("CONFLICT", "The CLI settings changed. Reload and try again.");
    }
    const updated = await tx.cliSettings.findUniqueOrThrow({
      where: { id: current.id },
    });
    await writeAudit(tx, actor, {
      eventType: "cli_settings.updated",
      subjectType: "cli_settings",
      subjectId: current.id,
      metadata: {
        before: {
          appendixSha256: contentHash(current.appendix),
          version: current.version,
        },
        after: {
          appendixSha256: contentHash(updated.appendix),
          version: updated.version,
        },
      },
    });
    return serializeCliSettings(updated);
  });
}

export async function listResources(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  sort?: "name.asc" | "name.desc" | "updatedAt.asc" | "updatedAt.desc" | undefined;
}): Promise<{ items: ResourceDto[]; total: number }> {
  const page = positiveInteger(input.page, 1);
  const pageSize = Math.min(positiveInteger(input.pageSize, 20), MAX_PAGE_SIZE);
  const q = input.q?.trim();
  const where: Prisma.DownstreamResourceWhereInput = q
    ? {
        OR: [
          { key: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
          { resourceIdentifier: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};
  const orderBy: Prisma.DownstreamResourceOrderByWithRelationInput[] =
    input.sort === "name.desc"
      ? [{ name: "desc" }, { key: "asc" }]
      : input.sort === "updatedAt.asc"
        ? [{ updatedAt: "asc" }, { key: "asc" }]
        : input.sort === "updatedAt.desc"
          ? [{ updatedAt: "desc" }, { key: "asc" }]
          : [{ name: "asc" }, { key: "asc" }];
  const [items, total] = await Promise.all([
    db.downstreamResource.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: resourceInclude,
    }),
    db.downstreamResource.count({ where }),
  ]);
  return { items: items.map(serializeResource), total };
}

export async function getResource(id: string): Promise<ResourceDto> {
  const resource = await db.downstreamResource.findUnique({
    where: { id },
    include: resourceInclude,
  });
  if (!resource) throw new AdminDomainError("NOT_FOUND", "Resource not found.");
  return serializeResource(resource);
}

export async function createResource(
  input: {
    key: string;
    name: string;
    resourceIdentifier: string;
    authorizationServer: string;
    downstreamClientId: string;
    enabled: boolean;
    skillDiscoveryEnabled: boolean;
    scopeIds: string[];
    requestPrefixes: string[];
  },
  actor: AdminActor,
): Promise<ResourceDto> {
  const parsed = parseResourceInput(input);
  try {
    return await db.$transaction(
      async (tx) => {
        await lockResourceChanges(tx);
        try {
          return serializeResource(
            await mutateResource(
              tx,
              {
                action: "create",
                key: parsed.key,
                name: parsed.name,
                resourceIdentifier: parsed.resourceIdentifier,
                authorizationServer: parsed.authorizationServer,
                downstreamClientId: parsed.downstreamClientId,
                enabled: parsed.enabled,
                skillDiscoveryEnabled: parsed.skillDiscoveryEnabled,
                scopeKeys: (await validateResourceScopes(tx, parsed.scopeIds)).map(
                  ({ key }) => key,
                ),
                requestPrefixes: parsed.requestPrefixes,
              },
              mutationActor(actor),
            ),
          );
        } catch (error) {
          throw mapPrimitiveError(error);
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isPrismaError(error, "P2002") || isPrismaError(error, "P2034")) {
      throw new AdminDomainError("CONFLICT", "The resource conflicts with another resource.");
    }
    throw error;
  }
}

export async function updateResource(
  input: {
    id: string;
    name: string;
    authorizationServer: string;
    downstreamClientId: string;
    enabled: boolean;
    skillDiscoveryEnabled: boolean;
    scopeIds: string[];
    requestPrefixes: string[];
    expectedVersion: number;
  },
  actor: AdminActor,
): Promise<ResourceDto> {
  const parsed = parseResourceInput(
    {
      ...input,
      key: "placeholder",
      resourceIdentifier: "https://placeholder.invalid",
    },
    false,
  );
  try {
    return await db.$transaction(
      async (tx) => {
        await lockResourceChanges(tx);
        const current = await tx.downstreamResource.findUnique({
          where: { id: input.id },
          include: resourceInclude,
        });
        if (!current) throw new AdminDomainError("NOT_FOUND", "Resource not found.");
        assertVersion(current.version, input.expectedVersion);
        try {
          return serializeResource(
            await mutateResource(
              tx,
              {
                action: "update",
                id: current.id,
                expectedVersion: input.expectedVersion,
                name: parsed.name,
                authorizationServer: parsed.authorizationServer,
                downstreamClientId: parsed.downstreamClientId,
                enabled: parsed.enabled,
                skillDiscoveryEnabled: parsed.skillDiscoveryEnabled,
                scopeKeys: (await validateResourceScopes(tx, parsed.scopeIds)).map(
                  ({ key }) => key,
                ),
                requestPrefixes: parsed.requestPrefixes,
              },
              mutationActor(actor),
            ),
          );
        } catch (error) {
          throw mapPrimitiveError(error);
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isPrismaError(error, "P2002") || isPrismaError(error, "P2034")) {
      throw new AdminDomainError("CONFLICT", "The resource conflicts with another resource.");
    }
    throw error;
  }
}

export async function deleteResource(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string }> {
  try {
    return await db.$transaction(
      async (tx) => {
        await lockResourceChanges(tx);
        const current = await tx.downstreamResource.findUnique({
          where: { id: input.id },
          include: resourceInclude,
        });
        if (!current) throw new AdminDomainError("NOT_FOUND", "Resource not found.");
        assertVersion(current.version, input.expectedVersion);
        try {
          return await mutateResource(
            tx,
            { action: "delete", id: current.id, expectedVersion: input.expectedVersion },
            mutationActor(actor),
          );
        } catch (error) {
          throw mapPrimitiveError(error);
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isPrismaError(error, "P2034")) {
      throw new AdminDomainError("CONFLICT", "The resource changed. Reload and try again.");
    }
    throw error;
  }
}

export async function listScopes(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  sort?: "key.asc" | "key.desc" | "updatedAt.asc" | "updatedAt.desc" | undefined;
}): Promise<{ items: ScopeDto[]; total: number }> {
  const page = positiveInteger(input.page, 1);
  const pageSize = Math.min(positiveInteger(input.pageSize, 20), MAX_PAGE_SIZE);
  const q = input.q?.trim();
  const where: Prisma.ScopeWhereInput = q
    ? {
        OR: [
          { key: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};
  const orderBy: Prisma.ScopeOrderByWithRelationInput =
    input.sort === "key.desc"
      ? { key: "desc" }
      : input.sort === "updatedAt.asc"
        ? { updatedAt: "asc" }
        : input.sort === "updatedAt.desc"
          ? { updatedAt: "desc" }
          : { key: "asc" };

  const [items, total] = await Promise.all([
    db.scope.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: scopeInclude,
    }),
    db.scope.count({ where }),
  ]);

  return {
    items: items.map((scope) =>
      serializeScope(scope, scope._count.grants + scope._count.groupGrants),
    ),
    total,
  };
}

export async function listScopeOptions(): Promise<
  Pick<ScopeDto, "id" | "key" | "description" | "isSystem">[]
> {
  return db.scope.findMany({
    orderBy: { key: "asc" },
    select: { id: true, key: true, description: true, isSystem: true },
  });
}

export async function createScope(
  input: { key: string; description: string },
  actor: AdminActor,
): Promise<ScopeDto> {
  const key = parseScopeKey(input.key);
  const description = parseScopeDescription(input.description);

  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    try {
      const scope = await mutateScope(
        tx,
        { action: "create", key, description },
        mutationActor(actor),
      );
      return serializeScope(scope, 0);
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function updateScope(
  input: { id: string; description: string; expectedVersion: number },
  actor: AdminActor,
): Promise<ScopeDto> {
  const description = parseScopeDescription(input.description);

  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    try {
      const updated = await mutateScope(
        tx,
        { action: "update", id: input.id, description, expectedVersion: input.expectedVersion },
        mutationActor(actor),
      );
      return serializeScope(updated, updated._count.grants + updated._count.groupGrants);
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function deleteScope(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string; affectedAssignments: number }> {
  return db.$transaction(async (tx) => {
    await lockSkillScopeChanges(tx);
    try {
      return await mutateScope(tx, { action: "delete", ...input }, mutationActor(actor));
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function listSkillSourceOptions(): Promise<SkillSourceOptionDto[]> {
  return db.downstreamResource.findMany({
    orderBy: [{ name: "asc" }, { key: "asc" }],
    select: { id: true, name: true },
  });
}

export async function listSkills(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  source?: string | undefined;
  sort?: "title.asc" | "title.desc" | "updatedAt.asc" | "updatedAt.desc" | undefined;
}): Promise<{ items: SkillDto[]; total: number }> {
  const page = positiveInteger(input.page, 1);
  const pageSize = Math.min(positiveInteger(input.pageSize, 20), MAX_PAGE_SIZE);
  const q = input.q?.trim();
  const source = input.source?.trim();
  const includeManual = !source || source === "manual";
  const includeDiscovered = source !== "manual";
  const textFilter = q
    ? {
        OR: [
          { slug: { contains: q, mode: "insensitive" as const } },
          { title: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};
  const discoveredFilter: Prisma.DiscoveredSkillWhereInput = {
    ...(q
      ? {
          OR: [
            { canonicalId: { contains: q, mode: "insensitive" as const } },
            { title: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(source && source !== "manual" ? { catalog: { resourceId: source } } : {}),
  };
  const [manual, discovered, scopes, manualSlugs] = await Promise.all([
    includeManual
      ? db.skill.findMany({ where: textFilter, include: skillInclude })
      : Promise.resolve([]),
    includeDiscovered
      ? db.discoveredSkill.findMany({
          where: discoveredFilter,
          include: { catalog: { include: { resource: true } } },
        })
      : Promise.resolve([]),
    db.scope.findMany({ select: { key: true } }),
    db.skill.findMany({ select: { slug: true } }),
  ]);
  const scopeRegistry = new Set(scopes.map((scope) => scope.key));
  const manualIds = new Set(manualSlugs.map((skill) => skill.slug));
  const items = [
    ...manual.map(serializeSkill),
    ...discovered.map((skill) =>
      serializeDiscoveredSkill(skill, scopeRegistry, manualIds.has(skill.canonicalId)),
    ),
  ];
  const direction = input.sort?.endsWith(".desc") ? -1 : 1;
  const byUpdatedAt = input.sort?.startsWith("updatedAt") ?? false;
  items.sort((left, right) => {
    const primary = byUpdatedAt
      ? left.updatedAt.localeCompare(right.updatedAt)
      : left.title.localeCompare(right.title);
    return direction * (primary || left.slug.localeCompare(right.slug));
  });
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
  };
}

export async function getSkill(id: string): Promise<SkillDto> {
  const [manual, discovered, scopes] = await Promise.all([
    db.skill.findUnique({ where: { id }, include: skillInclude }),
    db.discoveredSkill.findUnique({
      where: { id },
      include: { catalog: { include: { resource: true } } },
    }),
    db.scope.findMany({ select: { key: true } }),
  ]);
  if (manual) return serializeSkill(manual);
  if (!discovered) throw new AdminDomainError("NOT_FOUND", "Skill not found.");
  const overridden = Boolean(
    await db.skill.findUnique({
      where: { slug: discovered.canonicalId },
      select: { id: true },
    }),
  );
  return serializeDiscoveredSkill(
    discovered,
    new Set(scopes.map((scope) => scope.key)),
    overridden,
  );
}

export async function createSkill(
  input: {
    slug: string;
    title: string;
    content: string;
    requiredScopes: string[];
    visibility: SkillVisibilityDto;
  },
  actor: AdminActor,
): Promise<SkillDto> {
  return db.$transaction(async (tx) => {
    await lockSkillScopeChanges(tx);
    try {
      return serializeSkill(
        await mutateSkill(tx, { action: "create", ...input }, mutationActor(actor)),
      );
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function updateSkill(
  input: {
    id: string;
    title: string;
    content: string;
    requiredScopes: string[];
    visibility: SkillVisibilityDto;
    expectedVersion: number;
  },
  actor: AdminActor,
): Promise<SkillDto> {
  return db.$transaction(async (tx) => {
    await lockSkillScopeChanges(tx);
    try {
      return serializeSkill(
        await mutateSkill(tx, { action: "update", ...input }, mutationActor(actor)),
      );
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function deleteSkill(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    await lockSkillScopeChanges(tx);
    try {
      return await mutateSkill(tx, { action: "delete", ...input }, mutationActor(actor));
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function listAssignments(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  exactEmail?: string | undefined;
  sort?: "email.asc" | "email.desc" | "updatedAt.asc" | "updatedAt.desc" | undefined;
}): Promise<{ items: AssignmentDto[]; total: number }> {
  const page = positiveInteger(input.page, 1);
  const pageSize = Math.min(positiveInteger(input.pageSize, 20), MAX_PAGE_SIZE);
  const exactEmail = input.exactEmail ? normalizeEmail(input.exactEmail) : undefined;
  const q = input.q?.trim().toLowerCase();
  const where: Prisma.EmailScopeAssignmentWhereInput = {
    grants: { some: {} },
    ...(exactEmail
      ? { normalizedEmail: exactEmail }
      : q
        ? { normalizedEmail: { contains: q, mode: "insensitive" } }
        : {}),
  };
  const orderBy: Prisma.EmailScopeAssignmentOrderByWithRelationInput =
    input.sort === "email.desc"
      ? { normalizedEmail: "desc" }
      : input.sort === "updatedAt.asc"
        ? { updatedAt: "asc" }
        : input.sort === "updatedAt.desc"
          ? { updatedAt: "desc" }
          : { normalizedEmail: "asc" };

  const [items, total] = await Promise.all([
    db.emailScopeAssignment.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: assignmentInclude,
    }),
    db.emailScopeAssignment.count({ where }),
  ]);

  return { items: items.map(serializeAssignment), total };
}

export async function getAssignment(id: string): Promise<AssignmentDto> {
  const assignment = await db.emailScopeAssignment.findUnique({
    where: { id },
    include: assignmentInclude,
  });
  if (!assignment) throw new AdminDomainError("NOT_FOUND", "Assignment not found.");
  return serializeAssignment(assignment);
}

export async function getAssignmentByEmail(email: string): Promise<AssignmentDto | null> {
  const assignment = await db.emailScopeAssignment.findUnique({
    where: { normalizedEmail: normalizeEmail(email) },
    include: assignmentInclude,
  });
  return assignment ? serializeAssignment(assignment) : null;
}

export async function replaceAssignment(
  input: { email: string; scopeKeys: string[]; expectedVersion: number | null },
  actor: AdminActor,
): Promise<AssignmentDto | null> {
  const normalizedEmail = normalizeEmail(input.email);
  const scopeKeys = parseScopeKeys(input.scopeKeys);
  if (scopeKeys.includes(IAC_SCOPE_KEY)) {
    throw new AdminDomainError("SYSTEM_SCOPE", `${IAC_SCOPE_KEY} is machine-only.`);
  }
  try {
    return await db.$transaction(
      async (tx) => {
        await lockConfigurationChanges(tx);
        try {
          const assignment = await mutateEmailAssignment(
            tx,
            { email: normalizedEmail, scopeKeys, expectedVersion: input.expectedVersion },
            mutationActor(actor),
          );
          return assignment ? serializeAssignment(assignment) : null;
        } catch (error) {
          throw mapPrimitiveError(error);
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isPrismaError(error, "P2002") || isPrismaError(error, "P2034")) {
      throw new AdminDomainError("CONFLICT", "The assignment changed. Reload and try again.");
    }
    throw error;
  }
}

export async function deleteAssignment(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string; version: number }> {
  const assignment = await db.emailScopeAssignment.findUnique({
    where: { id: input.id },
    select: { normalizedEmail: true },
  });
  if (!assignment) throw new AdminDomainError("NOT_FOUND", "Assignment not found.");
  const deleted = await replaceAssignment(
    {
      email: assignment.normalizedEmail,
      scopeKeys: [],
      expectedVersion: input.expectedVersion,
    },
    actor,
  );
  if (!deleted) throw new AdminDomainError("NOT_FOUND", "Assignment not found.");
  return { id: deleted.id, version: deleted.version };
}

export async function bootstrapAdmin(email: string): Promise<AssignmentDto> {
  const normalizedEmail = normalizeEmail(email);
  const actor: AdminActor = {
    id: "deployment-bootstrap",
    requestId: randomUUID(),
  };

  return db.$transaction(
    async (tx) => {
      const requiredScopes = await tx.scope.findMany({
        where: { key: { in: [ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY] }, isSystem: true },
      });
      if (requiredScopes.length !== 2) {
        throw new AdminDomainError("NOT_FOUND", "The built-in bootstrap scopes are missing.");
      }
      const adminScope = requiredScopes.find((scope) => scope.key === ADMIN_SCOPE_KEY)!;
      const existing = await tx.emailScopeAssignment.findUnique({
        where: { normalizedEmail },
        include: { grants: { include: { scope: { select: { key: true } } } } },
      });
      const beforeScopes = existing
        ? sortedUnique(existing.grants.map((grant) => grant.scope.key))
        : [];
      const hasAdminScope = beforeScopes.includes(ADMIN_SCOPE_KEY);
      const hasLoginScope = beforeScopes.includes(LOGIN_SCOPE_KEY);
      if (hasAdminScope) {
        if (hasLoginScope) return serializeAssignment(existing!);
        throw new AdminDomainError(
          "CONFLICT",
          "Bootstrap is disabled after the first administrator exists.",
        );
      }
      if (
        await tx.emailScopeGrant.findFirst({
          where: { scopeId: adminScope.id },
          select: { id: true },
        })
      ) {
        throw new AdminDomainError(
          "CONFLICT",
          "Bootstrap is disabled after the first administrator exists.",
        );
      }

      const newGrants = requiredScopes
        .filter((scope) => !beforeScopes.includes(scope.key))
        .map((scope) => ({
          id: randomUUID(),
          scopeId: scope.id,
          createdBy: actor.id,
        }));
      const assignment = existing
        ? await tx.emailScopeAssignment.update({
            where: { id: existing.id },
            data: {
              version: { increment: 1 },
              updatedBy: actor.id,
              grants: { create: newGrants },
            },
            include: {
              grants: { include: { scope: { select: { key: true } } } },
            },
          })
        : await tx.emailScopeAssignment.create({
            data: {
              normalizedEmail,
              createdBy: actor.id,
              updatedBy: actor.id,
              grants: { create: newGrants },
            },
            include: {
              grants: { include: { scope: { select: { key: true } } } },
            },
          });
      const afterScopes = sortedUnique(assignment.grants.map((grant) => grant.scope.key));
      await writeAudit(tx, actor, {
        eventType: beforeScopes.length ? "user_scopes.replaced" : "user_scopes.created",
        subjectType: "email_scope_assignment",
        subjectId: assignment.id,
        metadata: {
          normalizedEmail,
          beforeScopes,
          afterScopes,
          addedScopes: afterScopes.filter((key) => !beforeScopes.includes(key)),
          removedScopes: [],
          source: "deployment_bootstrap",
          versionBefore: existing?.version ?? 0,
          versionAfter: assignment.version,
        },
      });
      return serializeAssignment(assignment);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export function countVerifiedAdminEmails(
  assignedEmails: string[],
  verifiedUserEmails: string[],
): number {
  const verifiedEmails = new Set(verifiedUserEmails.map(normalizeEmail));
  return new Set(assignedEmails.map(normalizeEmail).filter((email) => verifiedEmails.has(email)))
    .size;
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  actor: AdminActor,
  event: {
    eventType: AuditEventType;
    subjectType: string;
    subjectId: string;
    metadata: unknown;
  },
): Promise<void> {
  await prismaAuditWriter.write(
    {
      eventType: event.eventType,
      actorType: actor.id === "deployment-bootstrap" ? "machine" : "user",
      actorId: actor.id,
      ...(actor.email ? { actorEmail: normalizeEmail(actor.email) } : {}),
      requestId: actor.requestId,
      ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
      outcome: "success",
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      metadata: event.metadata,
    },
    tx,
  );
}

function parseResourceInput(
  input: {
    key: string;
    name: string;
    resourceIdentifier: string;
    authorizationServer: string;
    downstreamClientId: string;
    enabled: boolean;
    skillDiscoveryEnabled?: boolean;
    scopeIds: string[];
    requestPrefixes: string[];
  },
  validateImmutable = true,
) {
  const key = input.key.trim();
  const name = input.name.trim();
  const downstreamClientId = input.downstreamClientId.trim();
  if (validateImmutable && (key.length > 120 || !resourceKeyPattern.test(key))) {
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      "Resource keys must use lowercase letters, numbers, dots, dashes, or underscores.",
    );
  }
  if (name.length < 1 || name.length > 200) {
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      "Resource names must contain 1 to 200 characters.",
    );
  }
  if (downstreamClientId.length < 1 || downstreamClientId.length > 200) {
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      "Downstream client IDs must contain 1 to 200 characters.",
    );
  }
  let resourceIdentifier = input.resourceIdentifier;
  let authorizationServer: string;
  let requestPrefixes: string[];
  try {
    resourceIdentifier = validateImmutable
      ? normalizeResourceIdentifier(input.resourceIdentifier)
      : input.resourceIdentifier;
    authorizationServer = normalizeAuthorizationServer(input.authorizationServer);
    const normalizedPrefixes = input.requestPrefixes.map(normalizeRequestPrefix);
    if (new Set(normalizedPrefixes).size !== normalizedPrefixes.length) {
      throw new TypeError("Request prefixes must be unique after normalization");
    }
    requestPrefixes = normalizedPrefixes.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      error instanceof Error ? error.message : "Invalid resource URL.",
    );
  }
  if (!requestPrefixes.length || requestPrefixes.length > 100) {
    throw new AdminDomainError(
      "INVALID_RESOURCE",
      "A resource must have between 1 and 100 request prefixes.",
    );
  }
  return {
    key,
    name,
    resourceIdentifier,
    authorizationServer,
    downstreamClientId,
    enabled: input.enabled,
    skillDiscoveryEnabled: input.skillDiscoveryEnabled === true,
    scopeIds: sortedUnique(input.scopeIds),
    requestPrefixes,
  };
}

async function validateResourceScopes(tx: Prisma.TransactionClient, scopeIds: string[]) {
  if (scopeIds.length > 100) {
    throw new AdminDomainError("INVALID_RESOURCE", "A resource may support at most 100 scopes.");
  }
  const scopes = scopeIds.length
    ? await tx.scope.findMany({ where: { id: { in: scopeIds } } })
    : [];
  if (scopes.length !== scopeIds.length) {
    const known = new Set(scopes.map(({ id }) => id));
    throw new AdminDomainError("INVALID_SCOPE", "One or more scopes do not exist.", {
      unknownScopeIds: scopeIds.filter((id) => !known.has(id)),
    });
  }
  return scopes;
}

async function lockResourceChanges(tx: Prisma.TransactionClient): Promise<void> {
  await lockConfigurationChanges(tx);
}

function serializeResource(resource: {
  id: string;
  key: string;
  name: string;
  resourceIdentifier: string;
  authorizationServer: string;
  downstreamClientId: string;
  enabled: boolean;
  skillDiscoveryEnabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  scopes: { scope: { id: string; key: string } }[];
  requestPrefixes: { urlPrefix: string }[];
  discoveredCatalog: {
    lastAttemptAt: Date | null;
    lastSuccessfulRefreshAt: Date | null;
    nextRefreshAt: Date;
    staleAfter: Date | null;
    lastFailureCategory: string | null;
    lastFailureAt: Date | null;
    _count: { skills: number };
  } | null;
  iacBinding?: {
    address: string;
    workspace: { id: string; name: string };
  } | null;
}): ResourceDto {
  const now = new Date();
  const catalog = resource.discoveredCatalog;
  const catalogState =
    !resource.enabled || !resource.skillDiscoveryEnabled
      ? "disabled"
      : !catalog?.lastSuccessfulRefreshAt
        ? catalog?.lastFailureCategory
          ? "failed"
          : "pending"
        : catalog.staleAfter && catalog.staleAfter <= now
          ? "expired"
          : catalog.lastFailureCategory
            ? "failed"
            : catalog.nextRefreshAt <= now
              ? "stale"
              : "fresh";
  return {
    id: resource.id,
    key: resource.key,
    name: resource.name,
    resourceIdentifier: resource.resourceIdentifier,
    authorizationServer: resource.authorizationServer,
    downstreamClientId: resource.downstreamClientId,
    enabled: resource.enabled,
    skillDiscoveryEnabled: resource.skillDiscoveryEnabled,
    catalogStatus: catalog
      ? {
          state: catalogState,
          skillCount: catalog._count.skills,
          lastAttemptAt: catalog.lastAttemptAt?.toISOString() ?? null,
          lastSuccessfulRefreshAt: catalog.lastSuccessfulRefreshAt?.toISOString() ?? null,
          lastFailureCategory: catalog.lastFailureCategory,
          lastFailureAt: catalog.lastFailureAt?.toISOString() ?? null,
        }
      : null,
    version: resource.version,
    scopeIds: sortedUnique(resource.scopes.map(({ scope }) => scope.id)),
    scopeKeys: sortedUnique(resource.scopes.map(({ scope }) => scope.key)),
    requestPrefixes: sortedUnique(resource.requestPrefixes.map(({ urlPrefix }) => urlPrefix)),
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
    management: managementMetadata(resource.iacBinding),
  };
}

function serializeScope(
  scope: {
    id: string;
    key: string;
    description: string;
    isSystem: boolean;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    iacBinding?: {
      address: string;
      workspace: { id: string; name: string };
    } | null;
  },
  assignmentCount: number,
): ScopeDto {
  return {
    id: scope.id,
    key: scope.key,
    description: scope.description,
    isSystem: scope.isSystem,
    version: scope.version,
    assignmentCount,
    createdAt: scope.createdAt.toISOString(),
    updatedAt: scope.updatedAt.toISOString(),
    management: managementMetadata(scope.iacBinding),
  };
}

function serializeCliSettings(settings: {
  appendix: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): CliSettingsDto {
  return {
    appendix: settings.appendix,
    version: settings.version,
    createdAt: settings.createdAt.toISOString(),
    updatedAt: settings.updatedAt.toISOString(),
  };
}

function serializeSkill(skill: {
  id: string;
  slug: string;
  title: string;
  content: string;
  requiredScopes: string[];
  visibility: SkillVisibilityDto;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  iacBinding?: {
    address: string;
    workspace: { id: string; name: string };
  } | null;
}): SkillDto {
  return {
    id: skill.id,
    slug: skill.slug,
    title: skill.title,
    content: skill.content,
    requiredScopes: sortedUnique(skill.requiredScopes),
    visibility: skill.visibility,
    version: skill.version,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
    source: { type: "manual" },
    readOnly: false,
    disabled: false,
    scopeWarnings: [],
    overridden: false,
    management: managementMetadata(skill.iacBinding),
  };
}

function serializeDiscoveredSkill(
  skill: {
    id: string;
    canonicalId: string;
    title: string;
    content: string;
    requiredScopes: string[];
    visibility: SkillVisibilityDto;
    createdAt: Date;
    updatedAt: Date;
    catalog: {
      lastSuccessfulRefreshAt: Date | null;
      nextRefreshAt: Date;
      staleAfter: Date | null;
      lastFailureCategory: string | null;
      resource: {
        id: string;
        key: string;
        name: string;
        enabled: boolean;
        skillDiscoveryEnabled: boolean;
      };
    };
  },
  scopeRegistry: ReadonlySet<string>,
  overridden: boolean,
): SkillDto {
  const scopeWarnings = sortedUnique(
    skill.requiredScopes.flatMap((scope) =>
      scopeRegistry.has(scope) ? [] : [`Unknown scope: ${scope}`],
    ),
  );
  const resource = skill.catalog.resource;
  const now = new Date();
  const catalogState =
    !resource.enabled || !resource.skillDiscoveryEnabled
      ? "disabled"
      : !skill.catalog.lastSuccessfulRefreshAt
        ? skill.catalog.lastFailureCategory
          ? "failed"
          : "pending"
        : skill.catalog.staleAfter && skill.catalog.staleAfter <= now
          ? "expired"
          : skill.catalog.lastFailureCategory
            ? "failed"
            : skill.catalog.nextRefreshAt <= now
              ? "stale"
              : "fresh";
  return {
    id: skill.id,
    slug: skill.canonicalId,
    title: skill.title,
    content: skill.content,
    requiredScopes: sortedUnique(skill.requiredScopes),
    visibility: skill.visibility,
    version: 1,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
    source: {
      type: "resource",
      resourceId: resource.id,
      key: resource.key,
      name: resource.name,
      catalogState,
    },
    readOnly: true,
    disabled: !resource.enabled || !resource.skillDiscoveryEnabled,
    scopeWarnings,
    overridden,
    management: { type: "manual" },
  };
}

async function lockSkillScopeChanges(tx: Prisma.TransactionClient): Promise<void> {
  // Serialize skill-scope reference checks after the shared configuration lock.
  await lockAllSkillScopeChanges(tx);
}

function serializeUser(user: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
}): UserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
  };
}

function serializeAssignment(assignment: {
  id: string;
  normalizedEmail: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  grants: { scope: { key: string } }[];
  iacBinding?: {
    address: string;
    workspace: { id: string; name: string };
  } | null;
}): AssignmentDto {
  return {
    id: assignment.id,
    email: assignment.normalizedEmail,
    scopes: sortedUnique(assignment.grants.map((grant) => grant.scope.key)),
    version: assignment.version,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
    management: managementMetadata(assignment.iacBinding),
  };
}

function parseScopeKeys(rawKeys: string[]): string[] {
  const keys = sortedUnique(rawKeys.map(parseScopeKey));
  if (keys.length > MAX_ASSIGNMENT_SCOPES) {
    throw new AdminDomainError(
      "INVALID_SCOPE",
      `An assignment may contain at most ${MAX_ASSIGNMENT_SCOPES} scopes.`,
    );
  }
  return keys;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new AdminDomainError("CONFLICT", "The record changed. Reload and try again.", {
      currentVersion: current,
    });
  }
}

export function assertAdminCanBeRemoved(adminCount: number): void {
  if (adminCount <= 1) {
    throw new AdminDomainError("LAST_ADMIN", "The last administrator cannot be removed.");
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
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

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
