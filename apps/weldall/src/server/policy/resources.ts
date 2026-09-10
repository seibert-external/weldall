import { db, Prisma, SUBJECT_SCOPES_CHECK_SCOPE_KEY } from "@weldall/db";
import { resolveResourceForTarget, type ResourceRegistryEntry } from "@weldall/sdk";
import { z } from "zod";
import { lockConfigurationChanges } from "../domain/configuration";
import { decryptProviderToken } from "../group-providers/credentials";
import { createGroupProviderAdapter } from "../group-providers/registry";
import { errorForLog, logger } from "../observability/logger";
import { scopeKeySchema, type ScopeKey } from "./scope-key";
import { isProtectedSystemScope } from "./system-scopes";

const sortedUnique = <T extends string>(values: T[]): T[] => [...new Set(values)].sort();
const emailSchema = z.string().trim().toLowerCase().email().max(320);

interface ResolvedProviderMembership {
  providerId: string;
  providerVersion: number;
  groupIds: string[];
}

export type EffectiveScopeAssignment =
  | { type: "email"; id: string; email: string }
  | {
      type: "group";
      id: string;
      providerId: string;
      providerKey: string;
      providerName: string;
      groupId: string;
    };

export interface EffectiveScopeGrant {
  key: ScopeKey;
  assignments: EffectiveScopeAssignment[];
}

export interface EffectiveScopeAccess {
  effectiveScopes: EffectiveScopeGrant[];
  unavailableGroupProviders: { id: string; key: string; name: string }[];
}

interface ProviderMembershipResolution {
  memberships: ResolvedProviderMembership[];
  resolvedGroupProviders: { id: string; version: number }[];
  unavailableGroupProviders: EffectiveScopeAccess["unavailableGroupProviders"];
}

export async function effectiveScopeAccessFor(email: string): Promise<EffectiveScopeAccess> {
  const normalizedEmail = normalizePolicyEmail(email);
  const resolution = await resolveProviderMemberships(normalizedEmail);
  const effectiveScopes = await db.$transaction(
    (tx) => loadEffectiveScopeGrants(tx, normalizedEmail, resolution.memberships),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return {
    effectiveScopes,
    unavailableGroupProviders: resolution.unavailableGroupProviders,
  };
}

export async function effectiveScopesFor(email: string): Promise<ScopeKey[]> {
  const normalizedEmail = normalizePolicyEmail(email);
  const { memberships } = await resolveProviderMemberships(normalizedEmail);
  return db.$transaction((tx) => loadEffectiveScopes(tx, normalizedEmail, memberships), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

export async function hasEffectiveSystemScopeFor(
  email: string,
  scopeKey: string,
  transaction?: Prisma.TransactionClient,
): Promise<boolean> {
  const normalizedEmail = normalizePolicyEmail(email);
  const { memberships } = await resolveProviderMemberships(normalizedEmail, transaction);
  const check = async (tx: Prisma.TransactionClient) => {
    const [scope, effectiveScopes] = await Promise.all([
      tx.scope.findUnique({
        where: { key: scopeKey },
        select: { key: true, isSystem: true },
      }),
      loadEffectiveScopes(tx, normalizedEmail, memberships),
    ]);
    return (
      isProtectedSystemScope(scope, scopeKey) &&
      effectiveScopes.some((effectiveScope) => effectiveScope === scopeKey)
    );
  };
  return transaction
    ? check(transaction)
    : db.$transaction(check, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
}

export async function assignedScopesFor(email: string): Promise<ScopeKey[]> {
  return effectiveScopesFor(email);
}

export type SubjectScopeCheckErrorCode = "FORBIDDEN" | "NOT_FOUND" | "TEMPORARILY_UNAVAILABLE";

export class SubjectScopeCheckError extends Error {
  constructor(readonly code: SubjectScopeCheckErrorCode) {
    super(code);
    this.name = "SubjectScopeCheckError";
  }
}

export async function checkSubjectScopesForMachine(input: {
  clientId: string;
  keyId: string;
  keyThumbprint: string;
  subject: string;
  scopes: string[];
}): Promise<{ granted: ScopeKey[]; missing: ScopeKey[] }> {
  const requestedScopes = sortedUnique(input.scopes.map((scope) => scopeKeySchema.parse(scope)));
  const machine = await db.machineClient.findUnique({
    where: { clientId: input.clientId },
    include: {
      allowedResources: {
        where: { resource: { enabled: true } },
        include: {
          resource: {
            include: {
              scopes: {
                where: { scope: { key: { in: requestedScopes } } },
                select: { scope: { select: { key: true } } },
              },
            },
          },
        },
      },
    },
  });
  const queryableScopes = new Set(
    machine?.allowedResources.flatMap(({ resource }) =>
      resource.scopes.map(({ scope }) => scope.key),
    ) ?? [],
  );
  if (
    !machine?.enabled ||
    machine.deactivatedAt ||
    requestedScopes.some((scope) => !queryableScopes.has(scope))
  ) {
    throw new SubjectScopeCheckError("FORBIDDEN");
  }

  const user = await db.user.findUnique({
    where: { id: input.subject },
    select: { email: true, emailVerified: true },
  });
  if (!user?.emailVerified) throw new SubjectScopeCheckError("NOT_FOUND");

  const normalizedEmail = normalizePolicyEmail(user.email);
  const resolution = await resolveProviderMemberships(normalizedEmail);
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    const currentUsers = await tx.$queryRaw<Array<{ email: string; emailVerified: boolean }>>`
      SELECT "email", "emailVerified"
      FROM "User"
      WHERE "id" = ${input.subject}
      FOR SHARE
    `;
    const currentUser = currentUsers[0];
    const currentEmail = emailSchema.safeParse(currentUser?.email);
    if (
      currentUsers.length !== 1 ||
      !currentUser?.emailVerified ||
      !currentEmail.success ||
      currentEmail.data !== normalizedEmail
    ) {
      throw new SubjectScopeCheckError("NOT_FOUND");
    }
    const [effectiveGrants, authorizedMachine] = await Promise.all([
      loadEffectiveScopeGrants(tx, normalizedEmail, resolution.memberships),
      tx.machineClient.findFirst({
        where: {
          clientId: input.clientId,
          enabled: true,
          deactivatedAt: null,
          keys: {
            some: {
              kid: input.keyId,
              thumbprint: input.keyThumbprint,
              revokedAt: null,
            },
          },
          allowedScopes: { some: { scope: { key: SUBJECT_SCOPES_CHECK_SCOPE_KEY } } },
        },
        select: {
          allowedResources: {
            where: { resource: { enabled: true } },
            select: {
              resource: {
                select: {
                  scopes: {
                    where: { scope: { key: { in: requestedScopes } } },
                    select: { scope: { select: { key: true } } },
                  },
                },
              },
            },
          },
        },
      }),
    ]);
    const stillQueryable = new Set(
      authorizedMachine?.allowedResources.flatMap(({ resource }) =>
        resource.scopes.map(({ scope }) => scope.key),
      ) ?? [],
    );
    if (!authorizedMachine || requestedScopes.some((scope) => !stillQueryable.has(scope))) {
      throw new SubjectScopeCheckError("FORBIDDEN");
    }
    const effective = new Set(effectiveGrants.map(({ key }) => key));
    const granted = requestedScopes.filter((scope) => effective.has(scope));
    const missing = requestedScopes.filter((scope) => !effective.has(scope));
    if (missing.length) {
      const resolvedProviderVersions = resolution.resolvedGroupProviders.map(({ id, version }) => ({
        id,
        version,
      }));
      const uncertainGrant = await tx.groupScopeGrant.findFirst({
        where: {
          scope: { key: { in: missing } },
          assignment: {
            provider: {
              enabled: true,
              ...(resolvedProviderVersions.length ? { NOT: { OR: resolvedProviderVersions } } : {}),
            },
          },
        },
        select: { id: true },
      });
      if (uncertainGrant) throw new SubjectScopeCheckError("TEMPORARILY_UNAVAILABLE");
    }
    return { granted, missing };
  });
}

export async function resourceRegistryFor(email: string): Promise<ResourceRegistryEntry[]> {
  const normalizedEmail = normalizePolicyEmail(email);
  const { memberships } = await resolveProviderMemberships(normalizedEmail);
  return db.$transaction(
    async (tx) => {
      const [resources, assignedScopes] = await Promise.all([
        tx.downstreamResource.findMany({
          where: { enabled: true },
          orderBy: [{ name: "asc" }, { key: "asc" }],
          include: {
            requestPrefixes: { orderBy: { urlPrefix: "asc" } },
            scopes: { include: { scope: { select: { key: true } } } },
          },
        }),
        loadEffectiveScopes(tx, normalizedEmail, memberships),
      ]);
      const granted = new Set<string>(assignedScopes);
      return resources.map((resource) => {
        const supportedScopes = sortedUnique(
          resource.scopes.map(({ scope }) => scopeKeySchema.parse(scope.key)),
        );
        return {
          key: resource.key,
          name: resource.name,
          resourceIdentifier: resource.resourceIdentifier,
          authorizationServer: resource.authorizationServer,
          downstreamClientId: resource.downstreamClientId,
          requestPrefixes: resource.requestPrefixes.map((prefix) => prefix.urlPrefix),
          supportedScopes,
          grantedScopes: supportedScopes.filter((scope) => granted.has(scope)),
        };
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export interface ExchangePolicy {
  resourceIdentifier: string;
  authorizationServer: string;
  downstreamClientId: string;
  supportedScopes: string[];
  grantedScopes: string[];
}

export async function delegatedRequestPolicyFor(input: {
  email: string;
  target: URL;
  requiredSystemScope: string;
}): Promise<{ authorized: boolean; matches: ResourceRegistryEntry[] }> {
  const normalizedEmail = normalizePolicyEmail(input.email);
  const { memberships } = await resolveProviderMemberships(normalizedEmail);
  return db.$transaction(
    async (tx) => {
      const [resources, effectiveScopes, requiredScope] = await Promise.all([
        tx.downstreamResource.findMany({
          where: { enabled: true },
          include: {
            requestPrefixes: { orderBy: { urlPrefix: "asc" } },
            scopes: { include: { scope: { select: { key: true } } } },
          },
        }),
        loadEffectiveScopes(tx, normalizedEmail, memberships),
        tx.scope.findUnique({
          where: { key: input.requiredSystemScope },
          select: { key: true, isSystem: true },
        }),
      ]);
      const granted = new Set<string>(effectiveScopes);
      const registry = resources.map((resource) => {
        const supportedScopes = sortedUnique(
          resource.scopes.map(({ scope }) => scopeKeySchema.parse(scope.key)),
        );
        return {
          key: resource.key,
          name: resource.name,
          resourceIdentifier: resource.resourceIdentifier,
          authorizationServer: resource.authorizationServer,
          downstreamClientId: resource.downstreamClientId,
          requestPrefixes: resource.requestPrefixes.map((prefix) => prefix.urlPrefix),
          supportedScopes,
          grantedScopes: supportedScopes.filter((scope) => granted.has(scope)),
        };
      });
      return {
        authorized:
          isProtectedSystemScope(requiredScope, input.requiredSystemScope) &&
          granted.has(input.requiredSystemScope),
        matches: resolveResourceForTarget(registry, input.target),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

interface ExchangePolicyInput {
  email: string;
  resourceIdentifier: string;
  authorizationServer: string;
}

export async function exchangePolicyFor(
  input: ExchangePolicyInput,
): Promise<ExchangePolicy | null> {
  return (await loadExchangePolicy(input, { kind: "resource" })).policy;
}

export type SystemScopeRequiredExchange =
  { authorized: false } | { authorized: true; policy: ExchangePolicy | null };

export async function exchangePolicyRequiringSystemScopeFor(
  input: ExchangePolicyInput & { requiredSystemScope: string },
): Promise<SystemScopeRequiredExchange> {
  const result = await loadExchangePolicy(input, {
    kind: "required-system-scope",
    scopeKey: input.requiredSystemScope,
  });
  return result.authorized ? { authorized: true, policy: result.policy } : { authorized: false };
}

type ExchangePolicyRequirement =
  { kind: "resource" } | { kind: "required-system-scope"; scopeKey: string };

type LoadedExchangePolicy =
  | { kind: "resource"; policy: ExchangePolicy | null }
  | { kind: "required-system-scope"; authorized: boolean; policy: ExchangePolicy | null };

async function loadExchangePolicy(
  input: ExchangePolicyInput,
  requirement: { kind: "resource" },
): Promise<Extract<LoadedExchangePolicy, { kind: "resource" }>>;
async function loadExchangePolicy(
  input: ExchangePolicyInput,
  requirement: { kind: "required-system-scope"; scopeKey: string },
): Promise<Extract<LoadedExchangePolicy, { kind: "required-system-scope" }>>;
async function loadExchangePolicy(
  input: ExchangePolicyInput,
  requirement: ExchangePolicyRequirement,
): Promise<LoadedExchangePolicy> {
  const normalizedEmail = normalizePolicyEmail(input.email);
  // Remote membership resolution happens first. Current grants, provider versions, system-scope
  // metadata, and resource support are then read together so changes committed during the HTTP
  // calls win without resolving a provider twice for one exchange.
  const { memberships } = await resolveProviderMemberships(normalizedEmail);
  return db.$transaction(
    async (tx) => {
      const [resource, effectiveScopes, requiredScope] = await Promise.all([
        tx.downstreamResource.findFirst({
          where: {
            enabled: true,
            resourceIdentifier: input.resourceIdentifier,
            authorizationServer: input.authorizationServer,
          },
          include: { scopes: { include: { scope: { select: { key: true } } } } },
        }),
        loadEffectiveScopes(tx, normalizedEmail, memberships),
        requirement.kind === "required-system-scope"
          ? tx.scope.findUnique({
              where: { key: requirement.scopeKey },
              select: { key: true, isSystem: true },
            })
          : Promise.resolve(null),
      ]);
      const effective = new Set<string>(effectiveScopes);
      const policy = resource ? exchangePolicy(resource, effective) : null;
      if (requirement.kind === "resource") return { kind: requirement.kind, policy };
      return {
        kind: requirement.kind,
        authorized:
          isProtectedSystemScope(requiredScope, requirement.scopeKey) &&
          effective.has(requirement.scopeKey),
        policy,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function exchangePolicy(
  resource: {
    resourceIdentifier: string;
    authorizationServer: string;
    downstreamClientId: string;
    scopes: { scope: { key: string } }[];
  },
  effectiveScopes: ReadonlySet<string>,
): ExchangePolicy {
  const supportedScopes = sortedUnique(
    resource.scopes.map(({ scope }) => scopeKeySchema.parse(scope.key)),
  );
  return {
    resourceIdentifier: resource.resourceIdentifier,
    authorizationServer: resource.authorizationServer,
    downstreamClientId: resource.downstreamClientId,
    supportedScopes,
    grantedScopes: supportedScopes.filter((scope) => effectiveScopes.has(scope)),
  };
}

async function resolveProviderMemberships(
  normalizedEmail: string,
  transaction: Prisma.TransactionClient = db,
): Promise<ProviderMembershipResolution> {
  const providers = await transaction.groupProvider.findMany({
    where: { enabled: true, assignments: { some: {} } },
    orderBy: { key: "asc" },
    select: {
      id: true,
      key: true,
      name: true,
      adapterType: true,
      baseUrl: true,
      encryptedToken: true,
      encryptionKeyVersion: true,
      version: true,
    },
  });
  const memberships: ResolvedProviderMembership[] = [];
  const resolvedGroupProviders: ProviderMembershipResolution["resolvedGroupProviders"] = [];
  const unavailableGroupProviders: EffectiveScopeAccess["unavailableGroupProviders"] = [];

  // Sequential provider resolution is an intentionally conservative concurrency bound.
  for (const provider of providers) {
    const started = performance.now();
    try {
      const adapterType =
        provider.adapterType === "management-api-v1" ? provider.adapterType : null;
      if (!adapterType) throw new Error("unsupported_adapter");
      const adapter = createGroupProviderAdapter({
        adapterType,
        baseUrl: provider.baseUrl,
        token: decryptProviderToken(provider),
      });
      const summary = await adapter.findUserByEmail(normalizedEmail);
      if (!summary) {
        resolvedGroupProviders.push({ id: provider.id, version: provider.version });
        continue;
      }
      if (!summary.active || normalizePolicyEmail(summary.email) !== normalizedEmail) {
        throw new Error("invalid_summary_identity");
      }
      const detail = await adapter.getUser(summary.id);
      if (
        !detail.active ||
        detail.id !== summary.id ||
        normalizePolicyEmail(detail.email) !== normalizedEmail
      ) {
        throw new Error("invalid_detail_identity");
      }
      memberships.push({
        providerId: provider.id,
        providerVersion: provider.version,
        groupIds: sortedUnique(detail.groupIds),
      });
      resolvedGroupProviders.push({ id: provider.id, version: provider.version });
    } catch (error) {
      unavailableGroupProviders.push({ id: provider.id, key: provider.key, name: provider.name });
      logger.warn(
        {
          event: "group_provider.authorization_lookup.failed",
          providerId: provider.id,
          providerKey: provider.key,
          category: providerFailureCategory(error),
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          error: errorForLog(error),
        },
        "Group provider authorization lookup failed",
      );
    }
  }

  return { memberships, resolvedGroupProviders, unavailableGroupProviders };
}

async function loadEffectiveScopeGrants(
  tx: Prisma.TransactionClient,
  normalizedEmail: string,
  memberships: ResolvedProviderMembership[],
): Promise<EffectiveScopeGrant[]> {
  const assignmentFilters = groupAssignmentFilters(memberships);
  const [directGrants, groupGrants] = await Promise.all([
    tx.emailScopeGrant.findMany({
      where: { assignment: { normalizedEmail } },
      select: {
        assignment: { select: { id: true, normalizedEmail: true } },
        scope: { select: { key: true } },
      },
    }),
    assignmentFilters.length
      ? tx.groupScopeGrant.findMany({
          where: { assignment: { is: { OR: assignmentFilters } } },
          select: {
            assignment: {
              select: {
                id: true,
                groupId: true,
                provider: { select: { id: true, key: true, name: true } },
              },
            },
            scope: { select: { key: true } },
          },
        })
      : Promise.resolve([]),
  ]);
  const byScope = new Map<ScopeKey, Map<string, EffectiveScopeAssignment>>();
  const add = (scopeKey: string, assignment: EffectiveScopeAssignment) => {
    const key = scopeKeySchema.parse(scopeKey);
    const assignments = byScope.get(key) ?? new Map<string, EffectiveScopeAssignment>();
    assignments.set(`${assignment.type}:${assignment.id}`, assignment);
    byScope.set(key, assignments);
  };
  for (const grant of directGrants) {
    add(grant.scope.key, {
      type: "email",
      id: grant.assignment.id,
      email: grant.assignment.normalizedEmail,
    });
  }
  for (const grant of groupGrants) {
    add(grant.scope.key, {
      type: "group",
      id: grant.assignment.id,
      providerId: grant.assignment.provider.id,
      providerKey: grant.assignment.provider.key,
      providerName: grant.assignment.provider.name,
      groupId: grant.assignment.groupId,
    });
  }
  return [...byScope.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, assignments]) => ({
      key,
      assignments: [...assignments.values()].sort(compareEffectiveAssignments),
    }));
}

function compareEffectiveAssignments(
  left: EffectiveScopeAssignment,
  right: EffectiveScopeAssignment,
): number {
  const leftKey =
    left.type === "email"
      ? `0:${left.email}:${left.id}`
      : `1:${left.providerKey}:${left.groupId}:${left.id}`;
  const rightKey =
    right.type === "email"
      ? `0:${right.email}:${right.id}`
      : `1:${right.providerKey}:${right.groupId}:${right.id}`;
  return leftKey.localeCompare(rightKey);
}

function groupAssignmentFilters(
  memberships: ResolvedProviderMembership[],
): Prisma.GroupScopeAssignmentWhereInput[] {
  return memberships
    .filter(({ groupIds }) => groupIds.length > 0)
    .map(({ providerId, providerVersion, groupIds }) => ({
      providerId,
      groupId: { in: groupIds },
      provider: { enabled: true, version: providerVersion },
    }));
}

async function loadEffectiveScopes(
  tx: Prisma.TransactionClient,
  normalizedEmail: string,
  memberships: ResolvedProviderMembership[],
): Promise<ScopeKey[]> {
  const assignmentFilters = groupAssignmentFilters(memberships);
  const [directGrants, groupGrants] = await Promise.all([
    tx.emailScopeGrant.findMany({
      where: { assignment: { normalizedEmail } },
      select: { scope: { select: { key: true } } },
    }),
    assignmentFilters.length
      ? tx.groupScopeGrant.findMany({
          where: { assignment: { is: { OR: assignmentFilters } } },
          select: { scope: { select: { key: true } } },
        })
      : Promise.resolve([]),
  ]);
  return sortedUnique(
    [...directGrants, ...groupGrants].map(({ scope }) => scopeKeySchema.parse(scope.key)),
  );
}

function normalizePolicyEmail(email: string): string {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) throw new TypeError("Enter a valid email address.");
  return parsed.data;
}

function providerFailureCategory(error: unknown): string {
  if (error && typeof error === "object" && "category" in error) {
    const category = Reflect.get(error, "category");
    return typeof category === "string" ? category : "provider_error";
  }
  return error instanceof Error && error.message.startsWith("invalid_")
    ? error.message
    : "provider_error";
}
