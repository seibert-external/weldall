import { db, Prisma } from "@weldall/db";
import type { ResourceRegistryEntry } from "@weldall/sdk";
import { normalizeEmail } from "../admin/service";
import { decryptProviderToken } from "../group-providers/credentials";
import { createGroupProviderAdapter } from "../group-providers/registry";
import { scopeKeySchema, type ScopeKey } from "./scope-key";

const sortedUnique = <T extends string>(values: T[]): T[] => [...new Set(values)].sort();

interface ResolvedProviderMembership {
  providerId: string;
  providerVersion: number;
  groupIds: string[];
}

export async function effectiveScopesFor(email: string): Promise<ScopeKey[]> {
  const normalizedEmail = normalizeEmail(email);
  const memberships = await resolveProviderMemberships(normalizedEmail);
  return db.$transaction((tx) => loadEffectiveScopes(tx, normalizedEmail, memberships), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

export async function assignedScopesFor(email: string): Promise<ScopeKey[]> {
  return effectiveScopesFor(email);
}

export async function resourceRegistryFor(email: string): Promise<ResourceRegistryEntry[]> {
  const normalizedEmail = normalizeEmail(email);
  const memberships = await resolveProviderMemberships(normalizedEmail);
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

export async function exchangePolicyFor(input: {
  email: string;
  resourceIdentifier: string;
  authorizationServer: string;
}): Promise<{
  resourceIdentifier: string;
  authorizationServer: string;
  downstreamClientId: string;
  supportedScopes: string[];
  grantedScopes: string[];
} | null> {
  const normalizedEmail = normalizeEmail(input.email);
  // Remote membership resolution happens first. Current grants, provider versions, and
  // resource support are then read together so changes committed during the HTTP calls win.
  const memberships = await resolveProviderMemberships(normalizedEmail);
  return db.$transaction(
    async (tx) => {
      const [resource, effectiveScopes] = await Promise.all([
        tx.downstreamResource.findFirst({
          where: {
            enabled: true,
            resourceIdentifier: input.resourceIdentifier,
            authorizationServer: input.authorizationServer,
          },
          include: { scopes: { include: { scope: { select: { key: true } } } } },
        }),
        loadEffectiveScopes(tx, normalizedEmail, memberships),
      ]);
      if (!resource) return null;
      const granted = new Set<string>(effectiveScopes);
      const supportedScopes = sortedUnique(
        resource.scopes.map(({ scope }) => scopeKeySchema.parse(scope.key)),
      );
      return {
        resourceIdentifier: resource.resourceIdentifier,
        authorizationServer: resource.authorizationServer,
        downstreamClientId: resource.downstreamClientId,
        supportedScopes,
        grantedScopes: supportedScopes.filter((scope) => granted.has(scope)),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function resolveProviderMemberships(
  normalizedEmail: string,
): Promise<ResolvedProviderMembership[]> {
  const providers = await db.groupProvider.findMany({
    where: { enabled: true, assignments: { some: {} } },
    select: {
      id: true,
      key: true,
      adapterType: true,
      baseUrl: true,
      encryptedToken: true,
      encryptionKeyVersion: true,
      version: true,
    },
  });
  const memberships: ResolvedProviderMembership[] = [];

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
      if (!summary) continue;
      if (!summary.active || normalizeEmail(summary.email) !== normalizedEmail) {
        throw new Error("invalid_summary_identity");
      }
      const detail = await adapter.getUser(summary.id);
      if (
        !detail.active ||
        detail.id !== summary.id ||
        normalizeEmail(detail.email) !== normalizedEmail
      ) {
        throw new Error("invalid_detail_identity");
      }
      memberships.push({
        providerId: provider.id,
        providerVersion: provider.version,
        groupIds: sortedUnique(detail.groupIds),
      });
    } catch (error) {
      console.warn("Group provider authorization lookup failed", {
        providerId: provider.id,
        providerKey: provider.key,
        category: providerFailureCategory(error),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      });
    }
  }

  return memberships;
}

async function loadEffectiveScopes(
  tx: Prisma.TransactionClient,
  normalizedEmail: string,
  memberships: ResolvedProviderMembership[],
): Promise<ScopeKey[]> {
  const assignmentFilters: Prisma.GroupScopeAssignmentWhereInput[] = memberships
    .filter(({ groupIds }) => groupIds.length > 0)
    .map(({ providerId, providerVersion, groupIds }) => ({
      providerId,
      groupId: { in: groupIds },
      provider: { enabled: true, version: providerVersion },
    }));
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

function providerFailureCategory(error: unknown): string {
  if (error && typeof error === "object" && "category" in error) {
    const category = Reflect.get(error, "category");
    return typeof category === "string" ? category : "provider_error";
  }
  return error instanceof Error && error.message.startsWith("invalid_")
    ? error.message
    : "provider_error";
}
