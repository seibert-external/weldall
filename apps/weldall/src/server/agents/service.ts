import { ADMIN_SCOPE_KEY, db, type Prisma } from "@weldall/db";
import { effectiveScopesFor } from "../policy/resources";

/**
 * The agents a person may use: discovered agents (`discovery.ts`) they own, or for which they hold
 * any one of the agent's scopes. That differs from a skill's `requiredScopes`, where all are
 * required: an agent's scopes say who it is shared with, not what it needs.
 */
export interface VisibleAgent {
  /** `<resource key>.<id at the resource>`. */
  id: string;
  /** The id at the resource, for changing or deleting an own agent there. */
  sourceId: string;
  name: string;
  description: string;
  /** True when the person asking shared this agent. */
  own: boolean;
  /** Display name of the person who shared it; null when Weldall does not know them (any more). */
  ownerName: string | null;
  scopes: string[];
  config: { format: string; version: number; definition: unknown };
  revision: number;
  updatedAt: string;
  expiresAt: string;
  /** Past its re-verification date at the resource. Flagged only; the client decides what to do. */
  expired: boolean;
  source: { type: "resource"; key: string; name: string };
}

export interface AgentWarning {
  source: string;
  code: "catalog_pending" | "catalog_temporarily_unavailable" | "catalog_expired";
}

export interface VisibleAgentsEnvelope {
  items: VisibleAgent[];
  warnings: AgentWarning[];
}

export async function listVisibleAgents(user: {
  id: string;
  email: string;
}): Promise<VisibleAgentsEnvelope> {
  const grants = await effectiveScopesFor(user.email);
  // An agent's scopes widen who sees it, and Weldall takes them from the resource as reported.
  // Weldall's own permissions (administration, login, ...) therefore never open an agent: no
  // resource can address administrators or simply everyone.
  const shareable = (
    await db.scope.findMany({
      where: { key: { in: [...grants] }, isSystem: false },
      select: { key: true },
    })
  ).map((scope) => scope.key);
  const now = new Date();
  const resources = await db.downstreamResource.findMany({
    where: { enabled: true, agentDiscoveryEnabled: true },
    orderBy: { key: "asc" },
    select: {
      key: true,
      name: true,
      version: true,
      discoveredCatalog: {
        select: {
          lastSuccessfulRefreshAt: true,
          staleAfter: true,
          sourceResourceVersion: true,
          lastFailureCategory: true,
          agents: {
            where: { OR: [{ ownerId: user.id }, { scopes: { hasSome: shareable } }] },
            orderBy: [{ name: "asc" }, { canonicalId: "asc" }],
          },
        },
      },
    },
  });
  const canViewCatalogIssues = new Set<string>(grants).has(ADMIN_SCOPE_KEY);
  const warnings: AgentWarning[] = [];
  const visible: Array<{
    resource: (typeof resources)[number];
    agent: NonNullable<(typeof resources)[number]["discoveredCatalog"]>["agents"][number];
  }> = [];
  // Same freshness rules as for discovered skills (`skills/service.ts`).
  for (const resource of resources) {
    const catalog = resource.discoveredCatalog;
    if (!catalog?.lastSuccessfulRefreshAt) {
      if (canViewCatalogIssues)
        warnings.push({
          source: resource.key,
          code: catalog?.lastFailureCategory
            ? "catalog_temporarily_unavailable"
            : "catalog_pending",
        });
      continue;
    }
    if (
      !catalog.staleAfter ||
      catalog.staleAfter <= now ||
      catalog.sourceResourceVersion !== resource.version
    ) {
      if (canViewCatalogIssues) warnings.push({ source: resource.key, code: "catalog_expired" });
      continue;
    }
    if (canViewCatalogIssues && catalog.lastFailureCategory)
      warnings.push({ source: resource.key, code: "catalog_temporarily_unavailable" });
    for (const agent of catalog.agents) visible.push({ resource, agent });
  }

  const ownerIds = [...new Set(visible.map(({ agent }) => agent.ownerId))];
  const owners = ownerIds.length
    ? await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } })
    : [];
  const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));

  return {
    items: visible
      .map(({ resource, agent }): VisibleAgent => ({
        id: agent.canonicalId,
        sourceId: agent.localId,
        name: agent.name,
        description: agent.description,
        own: agent.ownerId === user.id,
        ownerName: ownerNames.get(agent.ownerId) ?? null,
        scopes: agent.scopes,
        config: {
          format: agent.configFormat,
          version: agent.configVersion,
          definition: agent.config,
        },
        revision: agent.revision,
        updatedAt: agent.sourceUpdatedAt.toISOString(),
        expiresAt: agent.expiresAt.toISOString(),
        expired: agent.expiresAt <= now,
        source: { type: "resource", key: resource.key, name: resource.name },
      }))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
    warnings,
  };
}

/**
 * A discovered agent as an administrator sees it: who shared it with whom, from which resource.
 * The agent's definition (its instructions) is left out on purpose: administering Weldall does not
 * open what people wrote for the colleagues they shared it with.
 */
export interface AdminAgentDto {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  /** Null when Weldall does not know the owner the resource reported. */
  ownerName: string | null;
  ownerEmail: string | null;
  scopes: string[];
  revision: number;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  resource: { id: string; key: string; name: string };
}

/** Agents of resources whose agent discovery is on, by name. `source` is a resource id. */
export async function listDiscoveredAgents(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  source?: string | undefined;
}): Promise<{ items: AdminAgentDto[]; total: number }> {
  const page = Math.max(1, Math.trunc(input.page) || 1);
  const pageSize = Math.min(Math.max(1, Math.trunc(input.pageSize) || 20), 200);
  const q = input.q?.trim();
  const where: Prisma.DiscoveredAgentWhereInput = {
    catalog: {
      resource: {
        enabled: true,
        agentDiscoveryEnabled: true,
        ...(input.source ? { id: input.source } : {}),
      },
    },
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
            { scopes: { has: q } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.discoveredAgent.findMany({
      where,
      orderBy: [{ name: "asc" }, { canonicalId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        canonicalId: true,
        name: true,
        description: true,
        ownerId: true,
        scopes: true,
        revision: true,
        sourceUpdatedAt: true,
        expiresAt: true,
        catalog: { select: { resource: { select: { id: true, key: true, name: true } } } },
      },
    }),
    db.discoveredAgent.count({ where }),
  ]);
  const ownerIds = [...new Set(rows.map((row) => row.ownerId))];
  const owners = ownerIds.length
    ? await db.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const ownersById = new Map(owners.map((owner) => [owner.id, owner]));
  const now = new Date();
  return {
    total,
    items: rows.map((row) => ({
      id: row.canonicalId,
      name: row.name,
      description: row.description,
      ownerId: row.ownerId,
      ownerName: ownersById.get(row.ownerId)?.name ?? null,
      ownerEmail: ownersById.get(row.ownerId)?.email ?? null,
      scopes: [...row.scopes].sort(),
      revision: row.revision,
      updatedAt: row.sourceUpdatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      expired: row.expiresAt <= now,
      resource: row.catalog.resource,
    })),
  };
}
