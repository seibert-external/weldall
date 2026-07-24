import { createHash, randomUUID } from "node:crypto";
import { db, Prisma } from "@weldall/db";
import { z } from "zod";

export const ADMIN_SCOPE_KEY = "weldall:administer";
export const MAX_ASSIGNMENT_SCOPES = 100;
export const MAX_PAGE_SIZE = 100;

const scopeKeyPattern = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;
const emailSchema = z.string().email().max(320);

export type AdminErrorCode =
  | "CONFLICT"
  | "FORBIDDEN"
  | "INVALID_CLI_SETTINGS"
  | "INVALID_EMAIL"
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
}

export interface ScopeDto {
  id: string;
  key: string;
  description: string;
  isSystem: boolean;
  version: number;
  assignmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentDto {
  id: string;
  email: string;
  scopes: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDto {
  id: string;
  slug: string;
  title: string;
  content: string;
  requiredScopes: string[];
  hidden: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CliSettingsDto {
  appendix: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function normalizeEmail(rawEmail: string): string {
  const normalized = rawEmail.trim().toLowerCase();
  if (!emailSchema.safeParse(normalized).success) {
    throw new AdminDomainError("INVALID_EMAIL", "Enter a valid email address.");
  }
  return normalized;
}

export function parseScopeKey(rawKey: string): string {
  const key = rawKey.trim();
  if (key.length > 160 || !scopeKeyPattern.test(key)) {
    throw new AdminDomainError(
      "INVALID_SCOPE",
      "Scope keys must be lowercase namespace:permission values.",
    );
  }
  return key;
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

  return Boolean(
    await db.emailScopeGrant.findFirst({
      where: {
        assignment: { normalizedEmail },
        scope: { key: ADMIN_SCOPE_KEY, isSystem: true },
      },
      select: { id: true },
    }),
  );
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

export async function getCliSettings(): Promise<CliSettingsDto> {
  const settings = await db.cliSettings.findUnique({ where: { id: "default" } });
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
    const current = await tx.cliSettings.findUnique({ where: { id: "default" } });
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
    const updated = await tx.cliSettings.findUniqueOrThrow({ where: { id: current.id } });
    await writeAudit(tx, actor, {
      eventType: "cli_settings.updated",
      subjectType: "cli_settings",
      subjectId: current.id,
      metadata: {
        before: { appendixSha256: contentHash(current.appendix), version: current.version },
        after: { appendixSha256: contentHash(updated.appendix), version: updated.version },
      },
    });
    return serializeCliSettings(updated);
  });
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
      include: { _count: { select: { grants: true } } },
    }),
    db.scope.count({ where }),
  ]);

  return {
    items: items.map((scope) => serializeScope(scope, scope._count.grants)),
    total,
  };
}

export async function listScopeOptions(): Promise<
  Pick<ScopeDto, "id" | "key" | "description" | "isSystem">[]
> {
  return db.scope.findMany({
    orderBy: { key: "asc" },
    select: { id: true, key: true, description: true, isSystem: true },
    take: 1_000,
  });
}

export async function createScope(
  input: { key: string; description: string },
  actor: AdminActor,
): Promise<ScopeDto> {
  const key = parseScopeKey(input.key);
  const description = parseScopeDescription(input.description);

  return db.$transaction(async (tx) => {
    if (await tx.scope.findUnique({ where: { key }, select: { id: true } })) {
      throw new AdminDomainError("CONFLICT", `Scope ${key} already exists.`);
    }
    const scope = await tx.scope.create({
      data: { key, description, createdBy: actor.id, updatedBy: actor.id },
    });
    await writeAudit(tx, actor, {
      eventType: "scope.created",
      subjectType: "scope",
      subjectId: scope.id,
      metadata: { key, description, isSystem: false, version: scope.version },
    });
    return serializeScope(scope, 0);
  });
}

export async function updateScope(
  input: { id: string; description: string; expectedVersion: number },
  actor: AdminActor,
): Promise<ScopeDto> {
  const description = parseScopeDescription(input.description);

  return db.$transaction(async (tx) => {
    const current = await tx.scope.findUnique({
      where: { id: input.id },
      include: { _count: { select: { grants: true } } },
    });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Scope not found.");
    if (current.isSystem) {
      throw new AdminDomainError("SYSTEM_SCOPE", "System scopes cannot be changed.");
    }
    assertVersion(current.version, input.expectedVersion);
    if (current.description === description) {
      return serializeScope(current, current._count.grants);
    }

    const write = await tx.scope.updateMany({
      where: { id: current.id, version: input.expectedVersion },
      data: { description, version: { increment: 1 }, updatedBy: actor.id },
    });
    if (write.count !== 1) {
      throw new AdminDomainError("CONFLICT", "The scope changed. Reload and try again.");
    }
    const updated = await tx.scope.findUniqueOrThrow({
      where: { id: current.id },
      include: { _count: { select: { grants: true } } },
    });
    await writeAudit(tx, actor, {
      eventType: "scope.updated",
      subjectType: "scope",
      subjectId: current.id,
      metadata: {
        key: current.key,
        before: { description: current.description, version: current.version },
        after: { description: updated.description, version: updated.version },
      },
    });
    return serializeScope(updated, updated._count.grants);
  });
}

export async function deleteScope(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string; affectedAssignments: number }> {
  return db.$transaction(async (tx) => {
    await lockSkillScopeChanges(tx);
    const current = await tx.scope.findUnique({
      where: { id: input.id },
      include: {
        grants: {
          include: {
            assignment: {
              include: { grants: { include: { scope: { select: { key: true } } } } },
            },
          },
        },
      },
    });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Scope not found.");
    if (current.isSystem) {
      throw new AdminDomainError("SYSTEM_SCOPE", "System scopes cannot be deleted.");
    }
    assertVersion(current.version, input.expectedVersion);
    const referencedBySkill = await tx.skill.findFirst({
      where: { requiredScopes: { has: current.key } },
      select: { slug: true },
    });
    if (referencedBySkill) {
      throw new AdminDomainError(
        "CONFLICT",
        `Scope ${current.key} is required by skill ${referencedBySkill.slug}. Update that skill first.`,
      );
    }

    const affected = current.grants.map(({ assignment }) => ({
      id: assignment.id,
      email: assignment.normalizedEmail,
      version: assignment.version,
      beforeScopes: sortedUnique(assignment.grants.map((grant) => grant.scope.key)),
    }));

    const deleted = await tx.scope.deleteMany({
      where: { id: current.id, version: input.expectedVersion },
    });
    if (deleted.count !== 1) {
      throw new AdminDomainError("CONFLICT", "The scope changed. Reload and try again.");
    }
    for (const assignment of affected) {
      const afterScopes = assignment.beforeScopes.filter((key) => key !== current.key);
      const assignmentWrite = await tx.emailScopeAssignment.updateMany({
        where: { id: assignment.id, version: assignment.version },
        data: { version: { increment: 1 }, updatedBy: actor.id },
      });
      if (assignmentWrite.count !== 1) {
        throw new AdminDomainError(
          "CONFLICT",
          "An affected assignment changed. Reload and try again.",
        );
      }
      await writeAudit(tx, actor, {
        eventType: afterScopes.length ? "user_scopes.replaced" : "user_scopes.deleted",
        subjectType: "email_scope_assignment",
        subjectId: assignment.id,
        metadata: {
          normalizedEmail: assignment.email,
          beforeScopes: assignment.beforeScopes,
          afterScopes,
          addedScopes: [],
          removedScopes: [current.key],
          source: "scope_delete_cascade",
          versionBefore: assignment.version,
          versionAfter: assignment.version + 1,
        },
      });
    }
    await writeAudit(tx, actor, {
      eventType: "scope.deleted",
      subjectType: "scope",
      subjectId: current.id,
      metadata: {
        key: current.key,
        description: current.description,
        version: current.version,
        affectedAssignments: affected.length,
      },
    });

    return { id: current.id, affectedAssignments: affected.length };
  });
}

export async function listSkills(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  sort?: "title.asc" | "title.desc" | "updatedAt.asc" | "updatedAt.desc" | undefined;
}): Promise<{ items: SkillDto[]; total: number }> {
  const page = positiveInteger(input.page, 1);
  const pageSize = Math.min(positiveInteger(input.pageSize, 20), MAX_PAGE_SIZE);
  const q = input.q?.trim();
  const where: Prisma.SkillWhereInput = q
    ? {
        OR: [
          { slug: { contains: q, mode: "insensitive" } },
          { title: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};
  const orderBy: Prisma.SkillOrderByWithRelationInput =
    input.sort === "title.desc"
      ? { title: "desc" }
      : input.sort === "updatedAt.asc"
        ? { updatedAt: "asc" }
        : input.sort === "updatedAt.desc"
          ? { updatedAt: "desc" }
          : { title: "asc" };
  const [items, total] = await Promise.all([
    db.skill.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.skill.count({ where }),
  ]);
  return { items: items.map(serializeSkill), total };
}

export async function getSkill(id: string): Promise<SkillDto> {
  const skill = await db.skill.findUnique({ where: { id } });
  if (!skill) throw new AdminDomainError("NOT_FOUND", "Skill not found.");
  return serializeSkill(skill);
}

export async function createSkill(
  input: {
    slug: string;
    title: string;
    content: string;
    requiredScopes: string[];
    hidden: boolean;
  },
  actor: AdminActor,
): Promise<SkillDto> {
  const parsed = parseSkillInput(input);
  try {
    return await db.$transaction(async (tx) => {
      await lockSkillScopeChanges(tx);
      await assertSkillScopesExist(tx, parsed.requiredScopes);
      const skill = await tx.skill.create({
        data: { ...parsed, createdBy: actor.id, updatedBy: actor.id },
      });
      await writeAudit(tx, actor, {
        eventType: "skill.created",
        subjectType: "skill",
        subjectId: skill.id,
        metadata: {
          slug: skill.slug,
          title: skill.title,
          requiredScopes: skill.requiredScopes,
          hidden: skill.hidden,
          contentSha256: contentHash(skill.content),
          version: skill.version,
        },
      });
      return serializeSkill(skill);
    });
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      throw new AdminDomainError("CONFLICT", `Skill ${parsed.slug} already exists.`);
    }
    throw error;
  }
}

export async function updateSkill(
  input: {
    id: string;
    title: string;
    content: string;
    requiredScopes: string[];
    hidden: boolean;
    expectedVersion: number;
  },
  actor: AdminActor,
): Promise<SkillDto> {
  const parsed = parseSkillInput({ ...input, slug: "placeholder" }, false);
  return db.$transaction(async (tx) => {
    await lockSkillScopeChanges(tx);
    await assertSkillScopesExist(tx, parsed.requiredScopes);
    const current = await tx.skill.findUnique({ where: { id: input.id } });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Skill not found.");
    assertVersion(current.version, input.expectedVersion);
    if (
      current.title === parsed.title &&
      current.content === parsed.content &&
      current.hidden === parsed.hidden &&
      sameStrings(current.requiredScopes, parsed.requiredScopes)
    ) {
      return serializeSkill(current);
    }
    const write = await tx.skill.updateMany({
      where: { id: current.id, version: input.expectedVersion },
      data: {
        title: parsed.title,
        content: parsed.content,
        requiredScopes: parsed.requiredScopes,
        hidden: parsed.hidden,
        version: { increment: 1 },
        updatedBy: actor.id,
      },
    });
    if (write.count !== 1) {
      throw new AdminDomainError("CONFLICT", "The skill changed. Reload and try again.");
    }
    const updated = await tx.skill.findUniqueOrThrow({ where: { id: current.id } });
    await writeAudit(tx, actor, {
      eventType: "skill.updated",
      subjectType: "skill",
      subjectId: current.id,
      metadata: {
        slug: current.slug,
        before: {
          title: current.title,
          requiredScopes: current.requiredScopes,
          hidden: current.hidden,
          contentSha256: contentHash(current.content),
          version: current.version,
        },
        after: {
          title: updated.title,
          requiredScopes: updated.requiredScopes,
          hidden: updated.hidden,
          contentSha256: contentHash(updated.content),
          version: updated.version,
        },
      },
    });
    return serializeSkill(updated);
  });
}

export async function deleteSkill(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    const current = await tx.skill.findUnique({ where: { id: input.id } });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Skill not found.");
    assertVersion(current.version, input.expectedVersion);
    const deleted = await tx.skill.deleteMany({
      where: { id: current.id, version: input.expectedVersion },
    });
    if (deleted.count !== 1) {
      throw new AdminDomainError("CONFLICT", "The skill changed. Reload and try again.");
    }
    await writeAudit(tx, actor, {
      eventType: "skill.deleted",
      subjectType: "skill",
      subjectId: current.id,
      metadata: {
        slug: current.slug,
        title: current.title,
        requiredScopes: current.requiredScopes,
        hidden: current.hidden,
        contentSha256: contentHash(current.content),
        version: current.version,
      },
    });
    return { id: current.id };
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
      include: { grants: { include: { scope: { select: { key: true } } } } },
    }),
    db.emailScopeAssignment.count({ where }),
  ]);

  return { items: items.map(serializeAssignment), total };
}

export async function getAssignmentByEmail(email: string): Promise<AssignmentDto | null> {
  const assignment = await db.emailScopeAssignment.findUnique({
    where: { normalizedEmail: normalizeEmail(email) },
    include: { grants: { include: { scope: { select: { key: true } } } } },
  });
  return assignment ? serializeAssignment(assignment) : null;
}

export async function replaceAssignment(
  input: { email: string; scopeKeys: string[]; expectedVersion: number | null },
  actor: AdminActor,
): Promise<AssignmentDto | null> {
  const normalizedEmail = normalizeEmail(input.email);
  const scopeKeys = parseScopeKeys(input.scopeKeys);
  try {
    return await db.$transaction(
      (tx) =>
        replaceAssignmentInTransaction(
          tx,
          { normalizedEmail, scopeKeys, expectedVersion: input.expectedVersion },
          actor,
        ),
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
  const actor: AdminActor = { id: "deployment-bootstrap", requestId: randomUUID() };

  return db.$transaction(async (tx) => {
    const adminScope = await tx.scope.findUnique({ where: { key: ADMIN_SCOPE_KEY } });
    if (!adminScope?.isSystem) {
      throw new AdminDomainError("NOT_FOUND", "The built-in administrator scope is missing.");
    }
    const existing = await tx.emailScopeAssignment.findUnique({
      where: { normalizedEmail },
      include: { grants: { include: { scope: { select: { key: true } } } } },
    });
    if (existing?.grants.some((grant) => grant.scope.key === ADMIN_SCOPE_KEY)) {
      return serializeAssignment(existing);
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

    const assignment = existing
      ? await tx.emailScopeAssignment.update({
          where: { id: existing.id },
          data: {
            version: { increment: 1 },
            updatedBy: actor.id,
            grants: {
              create: {
                id: randomUUID(),
                scopeId: adminScope.id,
                createdBy: actor.id,
              },
            },
          },
          include: { grants: { include: { scope: { select: { key: true } } } } },
        })
      : await tx.emailScopeAssignment.create({
          data: {
            normalizedEmail,
            createdBy: actor.id,
            updatedBy: actor.id,
            grants: {
              create: {
                id: randomUUID(),
                scopeId: adminScope.id,
                createdBy: actor.id,
              },
            },
          },
          include: { grants: { include: { scope: { select: { key: true } } } } },
        });
    await writeAudit(tx, actor, {
      eventType: "admin.bootstrap",
      subjectType: "email_scope_assignment",
      subjectId: assignment.id,
      metadata: { normalizedEmail, scope: ADMIN_SCOPE_KEY, version: assignment.version },
    });
    return serializeAssignment(assignment);
  });
}

async function replaceAssignmentInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    normalizedEmail: string;
    scopeKeys: string[];
    expectedVersion: number | null;
  },
  actor: AdminActor,
): Promise<AssignmentDto | null> {
  const current = await tx.emailScopeAssignment.findUnique({
    where: { normalizedEmail: input.normalizedEmail },
    include: { grants: { include: { scope: { select: { id: true, key: true } } } } },
  });
  const beforeScopes = current ? sortedUnique(current.grants.map((grant) => grant.scope.key)) : [];

  if (input.expectedVersion === null) {
    if (current && beforeScopes.length > 0) {
      throw new AdminDomainError(
        "CONFLICT",
        "The assignment already exists. Reload and try again.",
      );
    }
  } else if (!current || current.version !== input.expectedVersion) {
    throw new AdminDomainError("CONFLICT", "The assignment changed. Reload and try again.", {
      currentVersion: current?.version ?? null,
    });
  }

  if (sameStrings(beforeScopes, input.scopeKeys)) {
    return current ? serializeAssignment(current) : null;
  }

  const scopes = input.scopeKeys.length
    ? await tx.scope.findMany({ where: { key: { in: input.scopeKeys } } })
    : [];
  if (scopes.length !== input.scopeKeys.length) {
    const known = new Set(scopes.map((scope) => scope.key));
    throw new AdminDomainError("INVALID_SCOPE", "One or more scopes do not exist.", {
      unknownScopes: input.scopeKeys.filter((key) => !known.has(key)),
    });
  }

  if (beforeScopes.includes(ADMIN_SCOPE_KEY) && !input.scopeKeys.includes(ADMIN_SCOPE_KEY)) {
    assertAdminCanBeRemoved(await countVerifiedAdmins(tx));
  }

  if (!current && input.scopeKeys.length === 0) return null;

  let saved;
  if (current) {
    await tx.emailScopeGrant.deleteMany({ where: { assignmentId: current.id } });
    if (scopes.length) {
      await tx.emailScopeGrant.createMany({
        data: scopes.map((scope) => ({
          id: randomUUID(),
          assignmentId: current.id,
          scopeId: scope.id,
          createdBy: actor.id,
        })),
      });
    }
    const write = await tx.emailScopeAssignment.updateMany({
      where: { id: current.id, version: current.version },
      data: { version: { increment: 1 }, updatedBy: actor.id },
    });
    if (write.count !== 1) {
      throw new AdminDomainError("CONFLICT", "The assignment changed. Reload and try again.");
    }
    saved = await tx.emailScopeAssignment.findUniqueOrThrow({
      where: { id: current.id },
      include: { grants: { include: { scope: { select: { key: true } } } } },
    });
  } else {
    saved = await tx.emailScopeAssignment.create({
      data: {
        normalizedEmail: input.normalizedEmail,
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
      include: { grants: { include: { scope: { select: { key: true } } } } },
    });
  }

  const afterScopes = sortedUnique(saved.grants.map((grant) => grant.scope.key));
  const eventType =
    beforeScopes.length === 0
      ? "user_scopes.created"
      : afterScopes.length === 0
        ? "user_scopes.deleted"
        : "user_scopes.replaced";
  await writeAudit(tx, actor, {
    eventType,
    subjectType: "email_scope_assignment",
    subjectId: saved.id,
    metadata: {
      normalizedEmail: input.normalizedEmail,
      beforeScopes,
      afterScopes,
      addedScopes: afterScopes.filter((key) => !beforeScopes.includes(key)),
      removedScopes: beforeScopes.filter((key) => !afterScopes.includes(key)),
      versionBefore: current?.version ?? 0,
      versionAfter: saved.version,
    },
  });

  return serializeAssignment(saved);
}

async function countVerifiedAdmins(tx: Prisma.TransactionClient): Promise<number> {
  const [assignments, users] = await Promise.all([
    tx.emailScopeAssignment.findMany({
      where: { grants: { some: { scope: { key: ADMIN_SCOPE_KEY } } } },
      select: { normalizedEmail: true },
    }),
    tx.user.findMany({
      where: { emailVerified: true },
      select: { email: true },
    }),
  ]);
  return countVerifiedAdminEmails(
    assignments.map((assignment) => assignment.normalizedEmail),
    users.map((user) => user.email),
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
    eventType: string;
    subjectType: string;
    subjectId: string;
    metadata: Prisma.InputJsonObject;
  },
): Promise<void> {
  await tx.adminAuditEvent.create({
    data: {
      eventType: event.eventType,
      actorId: actor.id,
      actorEmail: actor.email ? normalizeEmail(actor.email) : null,
      requestId: actor.requestId,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      outcome: "success",
      metadata: event.metadata,
    },
  });
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
  hidden: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): SkillDto {
  return {
    id: skill.id,
    slug: skill.slug,
    title: skill.title,
    content: skill.content,
    requiredScopes: sortedUnique(skill.requiredScopes),
    hidden: skill.hidden,
    version: skill.version,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

async function lockSkillScopeChanges(tx: Prisma.TransactionClient): Promise<void> {
  // Serialize skill-scope reference checks with scope deletion to avoid orphaned scope keys.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(49350617)`;
}

async function assertSkillScopesExist(
  tx: Prisma.TransactionClient,
  requiredScopes: string[],
): Promise<void> {
  if (!requiredScopes.length) return;
  const knownScopes = await tx.scope.findMany({
    where: { key: { in: requiredScopes } },
    select: { key: true },
  });
  const known = new Set(knownScopes.map((scope) => scope.key));
  const unknownScopes = requiredScopes.filter((scope) => !known.has(scope));
  if (unknownScopes.length) {
    throw new AdminDomainError("INVALID_SCOPE", "One or more scopes do not exist.", {
      unknownScopes,
    });
  }
}

function parseSkillInput(
  input: {
    slug: string;
    title: string;
    content: string;
    requiredScopes: string[];
    hidden: boolean;
  },
  validateSlug = true,
): {
  slug: string;
  title: string;
  content: string;
  requiredScopes: string[];
  hidden: boolean;
} {
  const slug = input.slug.trim();
  const title = input.title.trim();
  const content = input.content.trim();
  if (validateSlug && (slug.length > 120 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(slug))) {
    throw new AdminDomainError(
      "INVALID_SKILL",
      "Skill IDs must use lowercase letters, numbers, dots, dashes, or underscores.",
    );
  }
  if (title.length < 1 || title.length > 200) {
    throw new AdminDomainError("INVALID_SKILL", "Skill titles must contain 1 to 200 characters.");
  }
  if (content.length < 1 || content.length > 100_000) {
    throw new AdminDomainError(
      "INVALID_SKILL",
      "Skill Markdown must contain 1 to 100,000 characters.",
    );
  }
  const requiredScopes = sortedUnique(input.requiredScopes.map(parseScopeKey));
  if (requiredScopes.length > MAX_ASSIGNMENT_SCOPES) {
    throw new AdminDomainError(
      "INVALID_SKILL",
      `A skill may require at most ${MAX_ASSIGNMENT_SCOPES} scopes.`,
    );
  }
  return { slug, title, content, requiredScopes, hidden: input.hidden };
}

function serializeAssignment(assignment: {
  id: string;
  normalizedEmail: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  grants: { scope: { key: string } }[];
}): AssignmentDto {
  return {
    id: assignment.id,
    email: assignment.normalizedEmail,
    scopes: sortedUnique(assignment.grants.map((grant) => grant.scope.key)),
    version: assignment.version,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
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

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
