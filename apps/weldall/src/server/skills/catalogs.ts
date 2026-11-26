import { randomUUID } from "node:crypto";
import { db, type Prisma } from "@weldall/db";
import { parseSkillCatalog, SKILL_ASSERTION_TYPE, type SkillCatalog } from "@weldall/sdk";
import {
  AGENT_API_METADATA_KEY,
  AGENT_CATALOG_METADATA_KEY,
  AgentCatalogError,
  fetchAgentCatalog,
  type AgentCatalogFailureCategory,
  type PublishedAgent,
  parseAgentApi,
} from "../agents/discovery";
import { WELDALL_ISSUER } from "../oauth/constants";
import { signWeldallJwt } from "../oauth/jwt";
import { errorForLog, logger } from "../observability/logger";

const REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
const MAX_STALE_MS = 24 * 60 * 60 * 1_000;
const LEASE_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const METADATA_LIMIT = 256_000;
const CATALOG_LIMIT = 1_048_576;
const MAX_REFRESHES_PER_SWEEP = 4;

/** Why a refresh failed as a whole; the skills (if any) stay as they were. */
export type CatalogFailureCategory =
  | "metadata_unavailable"
  | "metadata_invalid"
  | "catalog_unavailable"
  | "catalog_unauthorized"
  | "catalog_invalid"
  | "refresh_internal_error";

/**
 * Why only the agent side of a refresh failed (`agentsLastFailureCategory`). The skill side is
 * stored all the same, and the agents keep their last copy.
 */
export type AgentRefreshFailureCategory = AgentCatalogFailureCategory | "refresh_internal_error";

export interface CatalogRefreshSource {
  id: string;
  key: string;
  resourceIdentifier: string;
  authorizationServer: string;
  version: number;
  /** What the administrator allowed this resource to publish; at least one of them is on. */
  skillDiscoveryEnabled: boolean;
  agentDiscoveryEnabled: boolean;
}

class CatalogRefreshError extends Error {
  constructor(readonly category: CatalogFailureCategory) {
    super(category);
  }
}

/** What the log calls a refresh: it reads skills, agents or both. */
const catalogLabel = (source: CatalogRefreshSource): string =>
  source.skillDiscoveryEnabled && source.agentDiscoveryEnabled
    ? "Skill and agent catalog"
    : source.agentDiscoveryEnabled
      ? "Agent catalog"
      : "Skill catalog";

const deriveMetadataUrl = (resourceIdentifier: string): string => {
  const resource = new URL(resourceIdentifier);
  const metadata = new URL(resource.origin);
  metadata.pathname = `/.well-known/oauth-protected-resource${resource.pathname}`;
  metadata.search = resource.search;
  return metadata.toString();
};

const readBoundedJson = async (response: Response, limit: number): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new TypeError("unexpected content type");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new TypeError("response too large");
  }
  if (!response.body) throw new TypeError("response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new TypeError("response too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
};

/** An endpoint a resource names in its metadata: https, on the resource's origin, nothing else. */
const safeEndpoint = (value: string, resourceIdentifier: string): string => {
  const endpoint = new URL(value);
  const resource = new URL(resourceIdentifier);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== resource.origin ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("unsafe endpoint");
  }
  return endpoint.toString();
};

/**
 * Where the agent side reads, from the metadata. Metadata that names no usable agent endpoint or
 * API fails only the agent side, so it is answered as a failure rather than thrown.
 */
type AgentTarget =
  | { endpoint: string; api: { endpoint: string; scope: string } | null }
  | { failure: AgentRefreshFailureCategory };

const fetchMetadata = async (
  source: CatalogRefreshSource,
  fetcher: typeof fetch,
): Promise<{
  metadataUrl: string;
  catalogEndpoint: string | null;
  /** Null while agent discovery is off. */
  agents: AgentTarget | null;
}> => {
  const metadataUrl = deriveMetadataUrl(source.resourceIdentifier);
  let response: Response;
  try {
    response = await fetcher(metadataUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    throw new CatalogRefreshError("metadata_unavailable");
  }
  if (!response.ok) throw new CatalogRefreshError("metadata_unavailable");
  let value: unknown;
  try {
    value = await readBoundedJson(response, METADATA_LIMIT);
  } catch {
    throw new CatalogRefreshError("metadata_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogRefreshError("metadata_invalid");
  }
  const metadata = value as Record<string, unknown>;
  const authorizationServers = metadata.authorization_servers;
  const endpointValue = metadata.weldall_skills_endpoint;
  const agentsEndpointValue = metadata[AGENT_CATALOG_METADATA_KEY];
  const agentApiValue = metadata[AGENT_API_METADATA_KEY];
  if (
    metadata.resource !== source.resourceIdentifier ||
    !Array.isArray(authorizationServers) ||
    !authorizationServers.includes(source.authorizationServer) ||
    (source.skillDiscoveryEnabled && typeof endpointValue !== "string")
  ) {
    throw new CatalogRefreshError("metadata_invalid");
  }
  // An endpoint the administrator did not switch on is not read, whatever the resource names.
  let catalogEndpoint: string | null = null;
  try {
    if (source.skillDiscoveryEnabled)
      catalogEndpoint = safeEndpoint(endpointValue as string, source.resourceIdentifier);
  } catch {
    throw new CatalogRefreshError("metadata_invalid");
  }
  let agents: AgentTarget | null = null;
  if (source.agentDiscoveryEnabled) {
    try {
      if (typeof agentsEndpointValue !== "string") throw new TypeError("no agent endpoint");
      const api = agentApiValue === undefined ? null : parseAgentApi(agentApiValue);
      agents = {
        endpoint: safeEndpoint(agentsEndpointValue, source.resourceIdentifier),
        api: api && {
          endpoint: safeEndpoint(api.endpoint, source.resourceIdentifier),
          scope: api.scope,
        },
      };
    } catch {
      agents = { failure: "agents_metadata_invalid" };
    }
  }
  return { metadataUrl, catalogEndpoint, agents };
};

const fetchCatalog = async (
  source: CatalogRefreshSource,
  endpoint: string,
  fetcher: typeof fetch,
  now: Date,
): Promise<SkillCatalog> => {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const assertion = await signWeldallJwt(
    {
      iss: WELDALL_ISSUER,
      sub: WELDALL_ISSUER,
      aud: endpoint,
      resource: source.resourceIdentifier,
      purpose: "skills:read",
      iat: issuedAt,
      exp: issuedAt + 60,
      jti: randomUUID(),
    },
    SKILL_ASSERTION_TYPE,
  );
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${assertion}`,
      },
    });
  } catch {
    throw new CatalogRefreshError("catalog_unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new CatalogRefreshError("catalog_unauthorized");
  }
  if (!response.ok) throw new CatalogRefreshError("catalog_unavailable");
  try {
    return parseSkillCatalog(
      await readBoundedJson(response, CATALOG_LIMIT),
      source.resourceIdentifier,
    );
  } catch {
    throw new CatalogRefreshError("catalog_invalid");
  }
};

/** The agent side of a refresh; it never throws, so it cannot fail the skill side. */
type AgentRead =
  | {
      ok: true;
      agents: PublishedAgent[];
      skipped: number;
      api: { endpoint: string; scope: string } | null;
    }
  | { ok: false; category: AgentRefreshFailureCategory; error?: unknown };

const readAgents = async (
  source: CatalogRefreshSource,
  target: AgentTarget,
  fetcher: typeof fetch,
  now: Date,
): Promise<AgentRead> => {
  if ("failure" in target) return { ok: false, category: target.failure };
  try {
    const { agents, skipped } = await fetchAgentCatalog({
      resourceIdentifier: source.resourceIdentifier,
      endpoint: target.endpoint,
      fetcher,
      now,
      readJson: readBoundedJson,
    });
    return { ok: true, agents, skipped, api: target.api };
  } catch (error) {
    return error instanceof AgentCatalogError
      ? { ok: false, category: error.category }
      : { ok: false, category: "refresh_internal_error", error };
  }
};

const AGENT_INSERT_BATCH = 200;
/** Room for a large agent catalog; the lease is renewed at the start of the transaction. */
const PERSIST_TRANSACTION = { timeout: 15_000 } as const;

const failureBackoffMs = (retryCount: number): number =>
  Math.min(REFRESH_INTERVAL_MS, 30_000 * 2 ** Math.min(retryCount, 5));

async function persistFailure(
  catalogId: string,
  leaseId: string,
  category: CatalogFailureCategory,
  attemptedAt: Date,
): Promise<void> {
  const current = await db.discoveredSkillCatalog.findFirst({
    where: { id: catalogId, refreshLeaseId: leaseId },
    select: { retryCount: true },
  });
  if (!current) return;
  await db.discoveredSkillCatalog.updateMany({
    where: { id: catalogId, refreshLeaseId: leaseId },
    data: {
      lastAttemptAt: attemptedAt,
      lastFailureCategory: category,
      lastFailureAt: attemptedAt,
      retryCount: { increment: 1 },
      nextRefreshAt: new Date(attemptedAt.getTime() + failureBackoffMs(current.retryCount)),
      refreshLeaseId: null,
      refreshLeaseUntil: null,
    },
  });
}

/**
 * `agents_failed`: the skill side was stored, the agent side failed and kept its last copy.
 * `failed`: nothing was stored (the refresh failed as a whole, or the resource changed meanwhile).
 */
export type CatalogRefreshResult = "succeeded" | "agents_failed" | "failed";

export async function refreshCatalog(
  catalogId: string,
  leaseId: string,
  source: CatalogRefreshSource,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<CatalogRefreshResult> {
  const attemptedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const started = performance.now();
  try {
    const {
      metadataUrl,
      catalogEndpoint,
      agents: agentTarget,
    } = await fetchMetadata(source, fetcher);
    const catalog = catalogEndpoint
      ? await fetchCatalog(source, catalogEndpoint, fetcher, attemptedAt)
      : null;
    // The skill side above fails the refresh as it would without agents. The agent side has its
    // own outcome: when it fails, the skills are stored all the same and the agents keep their copy.
    const agentRead = agentTarget
      ? await readAgents(source, agentTarget, fetcher, attemptedAt)
      : null;
    const persisted = await db.$transaction(async (tx) => {
      const lease = await tx.discoveredSkillCatalog.updateMany({
        where: { id: catalogId, refreshLeaseId: leaseId },
        data: { refreshLeaseUntil: new Date(Date.now() + LEASE_MS) },
      });
      if (lease.count !== 1) return false;
      const currentResource = await tx.downstreamResource.findUnique({
        where: { id: source.id },
        select: {
          enabled: true,
          skillDiscoveryEnabled: true,
          agentDiscoveryEnabled: true,
          version: true,
          key: true,
        },
      });
      if (
        !currentResource?.enabled ||
        currentResource.skillDiscoveryEnabled !== source.skillDiscoveryEnabled ||
        currentResource.agentDiscoveryEnabled !== source.agentDiscoveryEnabled ||
        currentResource.version !== source.version ||
        currentResource.key !== source.key
      ) {
        await tx.discoveredSkillCatalog.updateMany({
          where: { id: catalogId, refreshLeaseId: leaseId },
          data: {
            refreshLeaseId: null,
            refreshLeaseUntil: null,
            nextRefreshAt: attemptedAt,
          },
        });
        return false;
      }
      await tx.discoveredSkill.deleteMany({ where: { catalogId } });
      if (catalog?.skills.length) {
        await tx.discoveredSkill.createMany({
          data: catalog.skills.map((skill) => ({
            catalogId,
            localId: skill.id,
            canonicalId: `${source.key}.${skill.id}`,
            title: skill.title,
            content: skill.content,
            requiredScopes: skill.requiredScopes,
            mcpDependencies: skill.mcpDependencies ?? [],
            visibility: skill.visibility,
            ...(skill.meta ? { meta: { ...skill.meta } } : {}),
            ...(skill.lastUpdatedAt !== undefined ? { lastUpdatedAt: skill.lastUpdatedAt } : {}),
          })),
        });
      }
      // Replaced when read, removed when agent discovery is off, kept when they could not be read.
      if (agentRead?.ok !== false) await tx.discoveredAgent.deleteMany({ where: { catalogId } });
      const agents = agentRead?.ok ? agentRead.agents : [];
      for (let start = 0; start < agents.length; start += AGENT_INSERT_BATCH) {
        await tx.discoveredAgent.createMany({
          data: agents.slice(start, start + AGENT_INSERT_BATCH).map((agent) => ({
            catalogId,
            localId: agent.id,
            canonicalId: `${source.key}.${agent.id}`,
            name: agent.name,
            description: agent.description,
            ownerId: agent.owner,
            scopes: agent.scopes,
            configFormat: agent.config.format,
            configVersion: agent.config.version,
            config: agent.config.definition as Prisma.InputJsonObject,
            revision: agent.revision,
            sourceCreatedAt: agent.createdAt,
            sourceUpdatedAt: agent.updatedAt,
            expiresAt: agent.expiresAt,
          })),
        });
      }
      const updated = await tx.discoveredSkillCatalog.updateMany({
        where: { id: catalogId, refreshLeaseId: leaseId },
        data: {
          sourceResourceVersion: source.version,
          schemaVersion: catalog?.schemaVersion ?? null,
          metadataUrl,
          catalogEndpoint,
          ...agentSideUpdate(agentRead, source.version, attemptedAt),
          lastAttemptAt: attemptedAt,
          lastSuccessfulRefreshAt: attemptedAt,
          nextRefreshAt: new Date(attemptedAt.getTime() + REFRESH_INTERVAL_MS),
          staleAfter: new Date(attemptedAt.getTime() + MAX_STALE_MS),
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          retryCount: 0,
          lastFailureCategory: null,
          lastFailureAt: null,
        },
      });
      if (updated.count !== 1) throw new Error(`${catalogLabel(source)} refresh lease was lost`);
      return true;
    }, PERSIST_TRANSACTION);
    if (!persisted) return "failed";
    logger.info(
      {
        event: "skill_catalog.refresh.succeeded",
        publisherId: source.id,
        publisherKey: source.key,
        resourceVersion: source.version,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        skillCount: catalog?.skills.length ?? 0,
        ...(agentRead?.ok
          ? { agentCount: agentRead.agents.length, skippedAgentCount: agentRead.skipped }
          : {}),
      },
      agentRead?.ok === false
        ? `${catalogLabel(source)} refresh stored the skills; the agents could not be read`
        : `${catalogLabel(source)} refresh succeeded`,
    );
    if (agentRead?.ok === false) {
      logger.warn(
        {
          event: "agent_catalog.refresh.failed",
          publisherId: source.id,
          publisherKey: source.key,
          resourceVersion: source.version,
          failureCategory: agentRead.category,
          ...(agentRead.error === undefined ? {} : { error: errorForLog(agentRead.error) }),
        },
        "Agent catalog refresh failed; the last copy of the agents stays",
      );
      return "agents_failed";
    }
    return "succeeded";
  } catch (error) {
    const category =
      error instanceof CatalogRefreshError ? error.category : "refresh_internal_error";
    await persistFailure(catalogId, leaseId, category, attemptedAt);
    logger.warn(
      {
        event: "skill_catalog.refresh.failed",
        publisherId: source.id,
        publisherKey: source.key,
        resourceVersion: source.version,
        failureCategory: category,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        error: errorForLog(error),
      },
      `${catalogLabel(source)} refresh failed`,
    );
    return "failed";
  }
}

/** The agent-side columns of the catalog row after a refresh whose skill side was stored. */
function agentSideUpdate(
  agentRead: AgentRead | null,
  resourceVersion: number,
  attemptedAt: Date,
): Prisma.DiscoveredSkillCatalogUpdateManyMutationInput {
  if (agentRead === null)
    return {
      agentApiEndpoint: null,
      agentApiScope: null,
      agentsSourceResourceVersion: null,
      agentsLastSuccessfulRefreshAt: null,
      agentsStaleAfter: null,
      agentsLastFailureCategory: null,
      agentsLastFailureAt: null,
      agentsSkippedCount: 0,
    };
  if (!agentRead.ok)
    return { agentsLastFailureCategory: agentRead.category, agentsLastFailureAt: attemptedAt };
  return {
    agentApiEndpoint: agentRead.api?.endpoint ?? null,
    agentApiScope: agentRead.api?.scope ?? null,
    agentsSourceResourceVersion: resourceVersion,
    agentsLastSuccessfulRefreshAt: attemptedAt,
    agentsStaleAfter: new Date(attemptedAt.getTime() + MAX_STALE_MS),
    agentsLastFailureCategory: null,
    agentsLastFailureAt: null,
    agentsSkippedCount: agentRead.skipped,
  };
}

export type ResourceCatalogRefreshOutcome =
  CatalogRefreshResult | "already_running" | "unavailable";

export async function refreshResourceCatalog(
  resourceId: string,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<ResourceCatalogRefreshOutcome> {
  const now = options.now ?? new Date();
  const resource = await db.downstreamResource.findUnique({
    where: { id: resourceId },
    select: {
      id: true,
      key: true,
      resourceIdentifier: true,
      authorizationServer: true,
      version: true,
      enabled: true,
      skillDiscoveryEnabled: true,
      agentDiscoveryEnabled: true,
    },
  });
  if (!resource?.enabled || !(resource.skillDiscoveryEnabled || resource.agentDiscoveryEnabled))
    return "unavailable";

  const catalog = await db.discoveredSkillCatalog.upsert({
    where: { resourceId },
    create: { resourceId, nextRefreshAt: now },
    update: {},
    select: { id: true },
  });
  const leaseId = randomUUID();
  const claimed = await db.discoveredSkillCatalog.updateMany({
    where: {
      id: catalog.id,
      OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }],
    },
    data: {
      refreshLeaseId: leaseId,
      refreshLeaseUntil: new Date(now.getTime() + LEASE_MS),
    },
  });
  if (claimed.count !== 1) return "already_running";

  return refreshCatalog(catalog.id, leaseId, resource, { ...options, now });
}

export async function refreshDueCatalogs(
  options: { fetcher?: typeof fetch; now?: Date; limit?: number } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? MAX_REFRESHES_PER_SWEEP, 1), 20);
  const due = await db.discoveredSkillCatalog.findMany({
    where: {
      nextRefreshAt: { lte: now },
      OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }],
      resource: {
        enabled: true,
        OR: [{ skillDiscoveryEnabled: true }, { agentDiscoveryEnabled: true }],
      },
    },
    orderBy: { nextRefreshAt: "asc" },
    take: limit,
    include: {
      resource: {
        select: {
          id: true,
          key: true,
          resourceIdentifier: true,
          authorizationServer: true,
          version: true,
          skillDiscoveryEnabled: true,
          agentDiscoveryEnabled: true,
        },
      },
    },
  });
  await Promise.all(
    due.map(async ({ id, resource }) => {
      const leaseId = randomUUID();
      const claimed = await db.discoveredSkillCatalog.updateMany({
        where: {
          id,
          nextRefreshAt: { lte: now },
          OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }],
        },
        data: {
          refreshLeaseId: leaseId,
          refreshLeaseUntil: new Date(now.getTime() + LEASE_MS),
        },
      });
      if (claimed.count !== 1) return;
      await refreshCatalog(id, leaseId, resource, { ...options, now });
    }),
  );
}
