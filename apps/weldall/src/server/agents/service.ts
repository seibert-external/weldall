import { ADMIN_SCOPE_KEY, db, type Prisma } from "@weldall/db";
import {
  catalogSideStatus,
  openingScopes,
  pageWindow,
  sideOffered,
  sideStatusSelect,
  sideVisibility,
  usersById,
  type CatalogSideState,
  type CatalogSideStatus,
  type CatalogSideWarning,
  type SideStatusColumns,
} from "../discovery/catalog-sides";

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
  /** When the agent was created and last changed at the resource, as it reports them. */
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Past its re-verification date at the resource. Flagged only; the client decides what to do. */
  expired: boolean;
  source: { type: "resource"; key: string; name: string };
}

/** Shown to administrators only. */
export type AgentWarning = CatalogSideWarning<"agents">;

/**
 * A resource that keeps agents for people: where a client stores and shares them. Listed for every
 * signed-in person; `allowed` says whether this person holds the permission the resource asks for.
 */
export interface AgentRegistry {
  key: string;
  name: string;
  /** The agents API, e.g. `https://registry.example.com/api/agents`. */
  endpoint: string;
  /** The permission to request for it. */
  scope: string;
  allowed: boolean;
}

/**
 * A permission the person holds and can therefore share an agent with. A registry's own
 * permission (`AgentRegistry.scope`) is left out.
 */
export interface ShareableScope {
  key: string;
  description: string;
}

export interface VisibleAgentsEnvelope {
  items: VisibleAgent[];
  warnings: AgentWarning[];
  registries: AgentRegistry[];
  shareableScopes: ShareableScope[];
}

/**
 * The agent side of a resource's catalog (`DiscoveredSkillCatalog.agents*`), kept apart from the
 * skill side so that agents that cannot be read never take the skills offline; see
 * `CatalogSideState` for the states.
 */
export type AgentCatalogState = CatalogSideState;
export type AgentCatalogStatus = CatalogSideStatus;

/** The catalog columns `agentCatalogStatus` reads. */
export const agentCatalogStatusSelect = sideStatusSelect("agents");

export const agentCatalogStatus = (
  resource: { enabled: boolean; agentDiscoveryEnabled: boolean; version: number },
  catalog: SideStatusColumns<"agents"> | null,
  now: Date = new Date(),
): AgentCatalogStatus => catalogSideStatus("agents", resource, catalog, now);

export async function listVisibleAgents(user: {
  id: string;
  email: string;
}): Promise<VisibleAgentsEnvelope> {
  // Weldall's own permissions never open an agent, nor can one be shared with them.
  const { grants, scopes: shareableScopes } = await openingScopes(user.email);
  const shareable = shareableScopes.map((scope) => scope.key);
  const now = new Date();
  const resources = await db.downstreamResource.findMany({
    where: { enabled: true, agentDiscoveryEnabled: true },
    orderBy: { key: "asc" },
    select: {
      key: true,
      name: true,
      version: true,
      enabled: true,
      agentDiscoveryEnabled: true,
      scopes: { select: { scope: { select: { key: true } } } },
      discoveredCatalog: {
        select: {
          ...agentCatalogStatusSelect,
          agentApiEndpoint: true,
          agentApiScope: true,
          agents: {
            where: { OR: [{ ownerId: user.id }, { scopes: { hasSome: shareable } }] },
            orderBy: [{ name: "asc" }, { canonicalId: "asc" }],
          },
        },
      },
    },
  });
  const canViewCatalogIssues = grants.has(ADMIN_SCOPE_KEY);
  const warnings: AgentWarning[] = [];
  const registries: AgentRegistry[] = [];
  const visible: Array<{
    resource: (typeof resources)[number];
    agent: NonNullable<(typeof resources)[number]["discoveredCatalog"]>["agents"][number];
  }> = [];
  for (const resource of resources) {
    const catalog = resource.discoveredCatalog;
    const status = agentCatalogStatus(resource, catalog, now);
    const { shown, warnings: issues } = sideVisibility(
      "agents",
      resource.key,
      status,
      canViewCatalogIssues,
    );
    warnings.push(...issues);
    if (!catalog || !shown) continue;
    for (const agent of catalog.agents) visible.push({ resource, agent });
    // Only a permission of the resource itself: a resource cannot make clients ask for another's.
    if (
      catalog.agentApiEndpoint &&
      catalog.agentApiScope &&
      resource.scopes.some(({ scope }) => scope.key === catalog.agentApiScope)
    )
      registries.push({
        key: resource.key,
        name: resource.name,
        endpoint: catalog.agentApiEndpoint,
        scope: catalog.agentApiScope,
        allowed: grants.has(catalog.agentApiScope),
      });
  }

  const owners = await usersById(visible.map(({ agent }) => agent.ownerId));

  return {
    items: visible
      .map(({ resource, agent }): VisibleAgent => ({
        id: agent.canonicalId,
        sourceId: agent.localId,
        name: agent.name,
        description: agent.description,
        own: agent.ownerId === user.id,
        ownerName: owners.get(agent.ownerId)?.name ?? null,
        scopes: agent.scopes,
        config: {
          format: agent.configFormat,
          version: agent.configVersion,
          definition: agent.config,
        },
        revision: agent.revision,
        createdAt: agent.sourceCreatedAt.toISOString(),
        updatedAt: agent.sourceUpdatedAt.toISOString(),
        expiresAt: agent.expiresAt.toISOString(),
        expired: agent.expiresAt <= now,
        source: { type: "resource", key: resource.key, name: resource.name },
      }))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
    warnings,
    registries,
    // The permission to keep agents at a registry says who may use the registry, not a group of
    // colleagues: it is not offered for sharing.
    shareableScopes: shareableScopes.filter(
      ({ key }) => !registries.some((registry) => registry.scope === key),
    ),
  };
}

/** How the directory names who shared an agent. */
export const sharedByLabel = (agent: Pick<VisibleAgent, "own" | "ownerName">): string =>
  agent.own ? "You" : (agent.ownerName ?? "Unknown");

/** One agent the person may use, by its id (`<resource key>.<id at the resource>`). */
export async function getVisibleAgent(
  user: { id: string; email: string },
  id: string,
): Promise<VisibleAgent | null> {
  return (await listVisibleAgents(user)).items.find((agent) => agent.id === id) ?? null;
}

/**
 * What the directory shows of an agent's definition. Discovery and `GET /api/me/agents` pass a
 * definition on without reading it; only the directory reads it, in the one format it knows how to
 * show (`weldall-agent`, version 1), and answers null for any other, which it then lists without
 * its content. Fields it does not understand are left out rather than refused.
 */
export interface AgentContent {
  instructions: string;
  /** The first message, sent when the chat opens. */
  prompt: string | null;
  starters: string[];
  /** The fields the agent asks for at its start. */
  inputs: Array<{ key: string; description: string }>;
  /** Null: every skill and connection of the person using it. */
  chosen: { skills: string[]; connections: string[] } | null;
}

/** The strings of a JSON array; anything else in it, or a value that is no array, is dropped. */
const stringItems = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** The value as a JSON object, or null when it is none (an array, a string, null, ...). */
const asJsonObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function agentContent(config: VisibleAgent["config"]): AgentContent | null {
  const definition = asJsonObject(config.definition);
  if (config.format !== "weldall-agent" || config.version !== 1 || !definition) return null;
  const tools = asJsonObject(definition.tools);
  if (typeof definition.instructions !== "string" || !tools) return null;
  return {
    instructions: definition.instructions,
    prompt: typeof definition.prompt === "string" && definition.prompt ? definition.prompt : null,
    starters: stringItems(definition.starters),
    inputs: (Array.isArray(definition.inputs) ? definition.inputs : []).flatMap((input) => {
      const field = asJsonObject(input);
      return field && typeof field.key === "string"
        ? [
            {
              key: field.key,
              description: typeof field.description === "string" ? field.description : "",
            },
          ]
        : [];
    }),
    chosen:
      tools.mode === "selected"
        ? { skills: stringItems(tools.skills), connections: stringItems(tools.connections) }
        : null,
  };
}

/**
 * True when an enabled resource has agent discovery switched on: only then do people have a place
 * agents can come from, and the directory shows its Agents tab.
 */
export const agentsOffered = (): Promise<boolean> => sideOffered("agents");

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
  /** As the resource reports them. */
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  resource: { id: string; key: string; name: string };
  /**
   * The state of the copy the agent comes from (`agentCatalogStatus`); in `expired` (and
   * `pending`) people do not see it, though it is still stored.
   */
  catalogState: AgentCatalogState;
}

/**
 * Agents of resources whose agent discovery is on, by name. `source` is a resource id. Like the
 * admin skill list, it also lists agents people cannot see at the moment and says so per row
 * (`catalogState`).
 */
export async function listDiscoveredAgents(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  source?: string | undefined;
}): Promise<{ items: AdminAgentDto[]; total: number }> {
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
      ...pageWindow(input),
      select: {
        canonicalId: true,
        name: true,
        description: true,
        ownerId: true,
        scopes: true,
        revision: true,
        sourceCreatedAt: true,
        sourceUpdatedAt: true,
        expiresAt: true,
        catalog: {
          select: {
            ...agentCatalogStatusSelect,
            resource: {
              select: {
                id: true,
                key: true,
                name: true,
                enabled: true,
                agentDiscoveryEnabled: true,
                version: true,
              },
            },
          },
        },
      },
    }),
    db.discoveredAgent.count({ where }),
  ]);
  const owners = await usersById(rows.map((row) => row.ownerId));
  const now = new Date();
  return {
    total,
    items: rows.map((row) => ({
      id: row.canonicalId,
      name: row.name,
      description: row.description,
      ownerId: row.ownerId,
      ownerName: owners.get(row.ownerId)?.name ?? null,
      ownerEmail: owners.get(row.ownerId)?.email ?? null,
      scopes: [...row.scopes].sort(),
      revision: row.revision,
      createdAt: row.sourceCreatedAt.toISOString(),
      updatedAt: row.sourceUpdatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      expired: row.expiresAt <= now,
      resource: {
        id: row.catalog.resource.id,
        key: row.catalog.resource.key,
        name: row.catalog.resource.name,
      },
      catalogState: agentCatalogStatus(row.catalog.resource, row.catalog, now).state,
    })),
  };
}
