import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db, isMachineOnlySystemScope, Prisma } from "@weldall/db";
import {
  groupProviderConfigSchema,
  publicGroupProvider,
} from "../domain/secret-primitive-contracts";
import { z } from "zod";
import {
  AdminDomainError,
  MAX_ASSIGNMENT_SCOPES,
  MAX_PAGE_SIZE,
  parseScopeKey,
  type AdminActor,
  type ManagementDto,
} from "../admin/service";
import { prismaAuditWriter } from "../audit/service";
import {
  lockConfigurationChanges,
  managementBindingInclude,
  managementMetadata,
} from "../domain/configuration";
import {
  mutateGroupAssignment,
  PrimitiveMutationError,
  type MutationActor,
} from "../domain/primitive-mutations";
import { decryptProviderToken, encryptProviderToken } from "./credentials";
import { createGroupProviderAdapter } from "./registry";
import type { GroupProviderAdapterType, GroupProviderGroup } from "./types";

const MAX_GROUPS_PER_ASSIGNMENT_BATCH = 100;
const providerKeyPattern = /^[a-z0-9][a-z0-9._-]*$/;

export interface GroupProviderDto {
  id: string;
  key: string;
  name: string;
  adapterType: GroupProviderAdapterType;
  baseUrl: string;
  enabled: boolean;
  version: number;
  hasToken: boolean;
  readiness: string;
  management: ManagementDto;
  assignmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupAssignmentDto {
  id: string;
  providerId: string;
  providerKey: string;
  providerName: string;
  groupId: string;
  scopes: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  management: ManagementDto;
}

const providerInclude = {
  _count: { select: { assignments: true } },
  iacBinding: managementBindingInclude,
} as const;
const assignmentInclude = {
  provider: { select: { key: true, name: true } },
  grants: { include: { scope: { select: { key: true } } } },
  iacBinding: managementBindingInclude,
} as const;

export async function listGroupProviders(): Promise<GroupProviderDto[]> {
  const providers = await db.groupProvider.findMany({
    orderBy: [{ name: "asc" }, { key: "asc" }],
    include: providerInclude,
  });
  return providers.map(serializeProvider);
}

export async function getGroupProvider(id: string): Promise<GroupProviderDto> {
  const provider = await db.groupProvider.findUnique({ where: { id }, include: providerInclude });
  if (!provider) throw new AdminDomainError("NOT_FOUND", "Group provider not found.");
  return serializeProvider(provider);
}

/** Shared public mutation; only the authorized UI entrypoint supplies a replacement token. */
export async function saveGroupProviderConfiguration(
  tx: Prisma.TransactionClient,
  input: {
    value: unknown;
    id?: string;
    expectedVersion: number | null;
    token?: string | undefined;
  },
  actor: MutationActor,
) {
  const config = groupProviderConfigSchema.parse(input.value);
  const current = input.id
    ? await tx.groupProvider.findUnique({ where: { id: input.id }, include: providerInclude })
    : null;
  if ((current?.version ?? null) !== input.expectedVersion) throw conflict("Group provider");
  if (current && (current.key !== config.key || current.adapterType !== config.adapterType))
    throw new AdminDomainError("INVALID_PROVIDER", "Provider identity and adapter cannot change.");
  if (actor.type === "machine" && input.token !== undefined)
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "Credentials can only be provisioned in the admin UI.",
    );
  const token = input.token?.trim() ? parseProviderToken(input.token) : undefined;
  if (current?.encryptedToken && current.baseUrl !== config.baseUrl && !token)
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "Changing the token destination requires a replacement token in the UI.",
    );
  if (config.enabled && !token && !current?.encryptedToken)
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "MISSING_CREDENTIAL: provision the token in the admin UI before enabling.",
    );
  if (current?.enabled && !config.enabled) await assertGroupProviderAdminSafe(tx, current.id);
  if (current && !token && isDeepStrictEqual(publicGroupProvider(current), config)) return current;
  const id = current?.id ?? randomUUID();
  const credential = token ? encryptProviderToken(id, token) : {};
  const row = current
    ? await tx.groupProvider.update({
        where: { id, version: current.version },
        data: {
          ...config,
          ...credential,
          version: { increment: 1 },
          updatedBy: actor.id,
        },
        include: providerInclude,
      })
    : await tx.groupProvider.create({
        data: {
          ...config,
          ...credential,
          id,
          encryptionKeyVersion: 1,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: providerInclude,
      });
  await writeProviderAudit(
    tx,
    actor,
    current ? "group_provider.updated" : "group_provider.created",
    row,
    Boolean(token),
  );
  return row;
}

async function assertGroupProviderAdminSafe(tx: Prisma.TransactionClient, id: string) {
  if (
    !(await tx.groupScopeGrant.count({
      where: { assignment: { providerId: id }, scope: { key: "weldall:administer" } },
    }))
  )
    return;
  const users = await tx.user.findMany({ where: { emailVerified: true }, select: { email: true } });
  if (
    !(await tx.emailScopeGrant.count({
      where: {
        scope: { key: "weldall:administer" },
        assignment: {
          normalizedEmail: { in: users.map(({ email }) => email.trim().toLowerCase()) },
        },
      },
    }))
  )
    throw new AdminDomainError(
      "CONFLICT",
      "Keep a verified direct administrator before disabling this group provider.",
    );
}

export async function removeGroupProviderConfiguration(
  tx: Prisma.TransactionClient,
  input: { id: string; expectedVersion: number },
  actor: MutationActor,
) {
  const provider = await tx.groupProvider.findUnique({
    where: { id: input.id },
    include: providerInclude,
  });
  if (!provider) throw new AdminDomainError("NOT_FOUND", "Group provider not found.");
  assertVersion(provider.version, input.expectedVersion, "Group provider");
  if (provider._count.assignments)
    throw new AdminDomainError(
      "CONFLICT",
      "Remove group assignments before deleting the provider.",
    );
  await tx.groupProvider.delete({ where: { id: input.id, version: input.expectedVersion } });
  await writeProviderAudit(tx, actor, "group_provider.deleted", provider, false);
  return { id: provider.id };
}

export async function createGroupProvider(
  input: {
    key: string;
    name: string;
    adapterType: GroupProviderAdapterType;
    baseUrl: string;
    token: string;
    enabled: boolean;
  },
  actor: AdminActor,
): Promise<GroupProviderDto> {
  const parsed = parseProviderInput(input);
  try {
    return await db.$transaction(async (tx) => {
      await lockConfigurationChanges(tx);
      return serializeProvider(
        await saveGroupProviderConfiguration(
          tx,
          { value: parsed, expectedVersion: null, token: input.token },
          mutationActor(actor),
        ),
      );
    });
  } catch (error) {
    if (isPrismaError(error, "P2002"))
      throw new AdminDomainError("CONFLICT", `Group provider ${parsed.key} already exists.`);
    throw error;
  }
}

export async function updateGroupProvider(
  input: {
    id: string;
    name: string;
    baseUrl: string;
    token?: string | undefined;
    enabled: boolean;
    expectedVersion: number;
  },
  actor: AdminActor,
): Promise<GroupProviderDto> {
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    const current = await tx.groupProvider.findUnique({ where: { id: input.id } });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Group provider not found.");
    return serializeProvider(
      await saveGroupProviderConfiguration(
        tx,
        {
          id: current.id,
          expectedVersion: input.expectedVersion,
          token: input.token,
          value: {
            ...publicGroupProvider(current),
            name: parseName(input.name),
            baseUrl: normalizeProviderBaseUrl(input.baseUrl),
            enabled: input.enabled,
          },
        },
        mutationActor(actor),
      ),
    );
  });
}

export async function deleteGroupProvider(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    return removeGroupProviderConfiguration(tx, input, mutationActor(actor));
  });
}

export async function testGroupProvider(
  input:
    | { id: string; baseUrl?: string | undefined; token?: string | undefined }
    | {
        key: string;
        adapterType: GroupProviderAdapterType;
        baseUrl: string;
        token: string;
      },
  actor: AdminActor,
): Promise<{ status: "ok"; latencyMs: number; groupCount: number }> {
  const provider =
    "id" in input
      ? await db.groupProvider.findUniqueOrThrow({ where: { id: input.id } }).then((stored) => {
          const baseUrl = input.baseUrl ? normalizeProviderBaseUrl(input.baseUrl) : stored.baseUrl;
          const replacement = input.token?.trim() ? parseProviderToken(input.token) : undefined;
          if (baseUrl !== stored.baseUrl && !replacement)
            throw new AdminDomainError(
              "INVALID_PROVIDER",
              "Testing a new destination requires a replacement token.",
            );
          return {
            ...stored,
            baseUrl,
            token: replacement ?? decryptProviderToken(stored),
            adapterType: z.literal("management-api-v1").parse(stored.adapterType),
            persisted: true,
          };
        })
      : {
          id: `configuration:${actor.requestId}`,
          key: parseProviderKey(input.key),
          adapterType: input.adapterType,
          baseUrl: normalizeProviderBaseUrl(input.baseUrl),
          token: parseProviderToken(input.token),
          enabled: true,
          version: 0,
          persisted: false,
        };
  const started = performance.now();
  try {
    const connection = await createGroupProviderAdapter({
      adapterType: provider.adapterType,
      baseUrl: provider.baseUrl,
      token: provider.token,
    }).testConnection();
    const result = {
      status: "ok" as const,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      groupCount: connection.groupCount,
    };
    await prismaAuditWriter.write(providerTestAudit(actor, provider, result));
    return result;
  } catch {
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    await prismaAuditWriter.write(
      providerTestAudit(actor, provider, {
        status: "failed",
        latencyMs,
        groupCount: null,
      }),
    );
    throw new AdminDomainError("INVALID_PROVIDER", "The group provider connection failed.");
  }
}

export async function searchProviderGroups(input: {
  providerId: string;
  query: string;
  limit: number;
}): Promise<GroupProviderGroup[]> {
  const provider = await loadProviderSecret(input.providerId);
  try {
    return await adapterFor(provider).searchGroups(input.query, Math.min(input.limit, 100));
  } catch {
    throw new AdminDomainError("INVALID_PROVIDER", "Could not search provider groups.");
  }
}

export async function getProviderGroups(input: {
  providerId: string;
  groupIds: string[];
}): Promise<GroupProviderGroup[]> {
  const groupIds = parseGroupIds(input.groupIds);
  const provider = await loadProviderSecret(input.providerId);
  try {
    return await adapterFor(provider).getGroups(groupIds);
  } catch {
    throw new AdminDomainError("INVALID_PROVIDER", "Could not load provider groups.");
  }
}

export async function listAssignedProviderGroupIds(providerId: string): Promise<string[]> {
  const provider = await db.groupProvider.findUnique({
    where: { id: providerId },
    select: { id: true },
  });
  if (!provider) throw new AdminDomainError("NOT_FOUND", "Group provider not found.");
  const assignments = await db.groupScopeAssignment.findMany({
    where: { providerId },
    orderBy: { groupId: "asc" },
    select: { groupId: true },
  });
  return assignments.map(({ groupId }) => groupId);
}

export async function listGroupAssignments(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
}): Promise<{ items: GroupAssignmentDto[]; total: number }> {
  const page = Math.max(1, input.page);
  const pageSize = Math.min(Math.max(1, input.pageSize), MAX_PAGE_SIZE);
  const q = input.q?.trim();
  const where: Prisma.GroupScopeAssignmentWhereInput = q
    ? {
        OR: [
          { groupId: { contains: q, mode: "insensitive" } },
          { provider: { key: { contains: q, mode: "insensitive" } } },
          { provider: { name: { contains: q, mode: "insensitive" } } },
        ],
      }
    : {};
  const [items, total] = await Promise.all([
    db.groupScopeAssignment.findMany({
      where,
      orderBy: [{ provider: { name: "asc" } }, { groupId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: assignmentInclude,
    }),
    db.groupScopeAssignment.count({ where }),
  ]);
  return { items: items.map(serializeAssignment), total };
}

export async function getGroupAssignment(id: string): Promise<GroupAssignmentDto> {
  const assignment = await db.groupScopeAssignment.findUnique({
    where: { id },
    include: assignmentInclude,
  });
  if (!assignment) throw new AdminDomainError("NOT_FOUND", "Group assignment not found.");
  return serializeAssignment(assignment);
}

export async function createGroupAssignments(
  input: { providerId: string; groupIds: string[]; scopeKeys: string[] },
  actor: AdminActor,
): Promise<GroupAssignmentDto[]> {
  const groupIds = parseGroupIds(input.groupIds);
  const scopeKeys = parseAssignmentScopeKeys(input.scopeKeys);
  const machineOnlyScope = scopeKeys.find(isMachineOnlySystemScope);
  if (machineOnlyScope)
    throw new AdminDomainError("SYSTEM_SCOPE", `${machineOnlyScope} is machine-only.`);
  try {
    return await db.$transaction(async (tx) => {
      await lockConfigurationChanges(tx);
      const provider = await tx.groupProvider.findUnique({ where: { id: input.providerId } });
      if (!provider) throw new AdminDomainError("NOT_FOUND", "Group provider not found.");
      const created: GroupAssignmentDto[] = [];
      for (const groupId of groupIds) {
        try {
          const assignment = await mutateGroupAssignment(
            tx,
            { action: "create", providerKey: provider.key, groupId, scopeKeys },
            mutationActor(actor),
          );
          created.push(serializeAssignment(assignment));
        } catch (error) {
          throw mapPrimitiveError(error);
        }
      }
      return created;
    });
  } catch (error) {
    if (isPrismaError(error, "P2002")) throw conflict("Group assignment");
    throw error;
  }
}

export async function replaceGroupAssignment(
  input: { id: string; scopeKeys: string[]; expectedVersion: number },
  actor: AdminActor,
): Promise<GroupAssignmentDto> {
  const scopeKeys = parseAssignmentScopeKeys(input.scopeKeys);
  const machineOnlyScope = scopeKeys.find(isMachineOnlySystemScope);
  if (machineOnlyScope)
    throw new AdminDomainError("SYSTEM_SCOPE", `${machineOnlyScope} is machine-only.`);
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    try {
      return serializeAssignment(
        await mutateGroupAssignment(
          tx,
          { action: "update", id: input.id, scopeKeys, expectedVersion: input.expectedVersion },
          mutationActor(actor),
        ),
      );
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export async function deleteGroupAssignment(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    try {
      return await mutateGroupAssignment(
        tx,
        { action: "delete", id: input.id, expectedVersion: input.expectedVersion },
        mutationActor(actor),
      );
    } catch (error) {
      throw mapPrimitiveError(error);
    }
  });
}

export function normalizeProviderBaseUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch {
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "Provider base URL must be an HTTPS origin without credentials, path, query, or fragment.",
    );
  }
}

function parseProviderInput(input: {
  key: string;
  name: string;
  adapterType: GroupProviderAdapterType;
  baseUrl: string;
  enabled: boolean;
}) {
  return {
    key: parseProviderKey(input.key),
    name: parseName(input.name),
    adapterType: input.adapterType,
    baseUrl: normalizeProviderBaseUrl(input.baseUrl),
    enabled: input.enabled,
  };
}

function parseProviderKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 1 || key.length > 120 || !providerKeyPattern.test(key)) {
    throw new AdminDomainError("INVALID_PROVIDER", "Enter a valid lowercase provider key.");
  }
  return key;
}

function parseName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > 200) {
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "Provider name must contain 1 to 200 characters.",
    );
  }
  return name;
}

function parseProviderToken(raw: string): string {
  const token = raw.trim();
  if (token.length < 1 || token.length > 10_000 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new AdminDomainError("INVALID_PROVIDER", "Enter a valid provider token.");
  }
  return token;
}

function parseGroupIds(values: string[]): string[] {
  const parsed = [...new Set(values.map((value) => value.trim()))];
  if (
    parsed.length < 1 ||
    parsed.length > MAX_GROUPS_PER_ASSIGNMENT_BATCH ||
    parsed.some((value) => value.length < 1 || value.length > 191)
  ) {
    throw new AdminDomainError("INVALID_GROUP", "Choose between 1 and 100 valid provider groups.");
  }
  return parsed;
}

function parseAssignmentScopeKeys(values: string[]) {
  const parsed = [...new Set(values.map(parseScopeKey))].sort();
  if (parsed.length < 1 || parsed.length > MAX_ASSIGNMENT_SCOPES) {
    throw new AdminDomainError("INVALID_SCOPE", "Choose between 1 and 100 scopes.");
  }
  return parsed;
}

async function loadProviderSecret(id: string) {
  const provider = await db.groupProvider.findUnique({ where: { id } });
  if (!provider) throw new AdminDomainError("NOT_FOUND", "Group provider not found.");
  if (!provider.enabled || !provider.encryptedToken)
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "Group provider is disabled or missing a credential.",
    );
  return { ...provider, token: decryptProviderToken(provider) };
}

function adapterFor(provider: Awaited<ReturnType<typeof loadProviderSecret>>) {
  return createGroupProviderAdapter({
    adapterType: z.literal("management-api-v1").parse(provider.adapterType),
    baseUrl: provider.baseUrl,
    token: provider.token,
  });
}

function serializeProvider(provider: {
  id: string;
  key: string;
  name: string;
  adapterType: string;
  baseUrl: string;
  enabled: boolean;
  version: number;
  encryptedToken: string | null;
  iacBinding?: { address: string; workspace: { id: string; name: string } } | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { assignments: number };
}): GroupProviderDto {
  return {
    id: provider.id,
    key: provider.key,
    name: provider.name,
    adapterType: z.literal("management-api-v1").parse(provider.adapterType),
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    version: provider.version,
    hasToken: Boolean(provider.encryptedToken),
    readiness: !provider.encryptedToken
      ? "MISSING_CREDENTIAL"
      : provider.enabled
        ? "READY"
        : "DISABLED",
    management: managementMetadata(provider.iacBinding),
    assignmentCount: provider._count.assignments,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

function serializeAssignment(assignment: {
  id: string;
  providerId: string;
  groupId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  provider: { key: string; name: string };
  grants: { scope: { key: string } }[];
  iacBinding?: {
    address: string;
    workspace: { id: string; name: string };
  } | null;
}): GroupAssignmentDto {
  return {
    id: assignment.id,
    providerId: assignment.providerId,
    providerKey: assignment.provider.key,
    providerName: assignment.provider.name,
    groupId: assignment.groupId,
    scopes: assignment.grants.map(({ scope }) => parseScopeKey(scope.key)).sort(),
    version: assignment.version,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
    management: managementMetadata(assignment.iacBinding),
  };
}

async function writeProviderAudit(
  tx: Prisma.TransactionClient,
  actor: AdminActor | MutationActor,
  eventType: "group_provider.created" | "group_provider.updated" | "group_provider.deleted",
  provider: {
    id: string;
    key: string;
    adapterType: string;
    baseUrl: string;
    enabled: boolean;
    version: number;
  },
  credentialChanged: boolean,
) {
  await prismaAuditWriter.write(
    {
      eventType,
      actorType: "type" in actor ? actor.type : "user",
      actorId: actor.id,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      requestId: actor.requestId,
      ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
      outcome: "success",
      subjectType: "group_provider",
      subjectId: provider.id,
      metadata: {
        providerKey: provider.key,
        adapterType: provider.adapterType,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        version: provider.version,
        credentialChanged,
      },
    },
    tx,
  );
}

function providerTestAudit(
  actor: AdminActor,
  provider: {
    id: string;
    key: string;
    adapterType: "management-api-v1";
    baseUrl: string;
    enabled: boolean;
    version: number;
    persisted: boolean;
  },
  result: { status: "ok" | "failed"; latencyMs: number; groupCount: number | null },
) {
  return {
    eventType: "group_provider.tested" as const,
    actorType: "user" as const,
    actorId: actor.id,
    ...(actor.email ? { actorEmail: actor.email } : {}),
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    outcome: result.status === "ok" ? ("success" as const) : ("failed" as const),
    ...(result.status === "failed" ? { reasonCode: "internal_error" as const } : {}),
    subjectType: "group_provider",
    subjectId: provider.id,
    metadata: {
      providerKey: provider.key,
      adapterType: provider.adapterType,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      version: provider.version,
      credentialChanged: false,
      persisted: provider.persisted,
      ...result,
    },
  };
}

function assertVersion(current: number, expected: number, subject: string) {
  if (current !== expected) throw conflict(subject);
}

function conflict(subject: string) {
  return new AdminDomainError("CONFLICT", `${subject} changed. Reload and try again.`);
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

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}
