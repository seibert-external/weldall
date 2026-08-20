import { randomUUID } from "node:crypto";
import { db } from "@weldall/db";
import { parseSkillCatalog, SKILL_ASSERTION_TYPE, type SkillCatalog } from "@weldall/sdk";
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

export type CatalogFailureCategory =
  | "metadata_unavailable"
  | "metadata_invalid"
  | "catalog_unavailable"
  | "catalog_unauthorized"
  | "catalog_invalid"
  | "refresh_internal_error";

export interface CatalogRefreshSource {
  id: string;
  key: string;
  resourceIdentifier: string;
  authorizationServer: string;
  version: number;
}

class CatalogRefreshError extends Error {
  constructor(readonly category: CatalogFailureCategory) {
    super(category);
  }
}

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

const fetchMetadata = async (
  source: CatalogRefreshSource,
  fetcher: typeof fetch,
): Promise<{ metadataUrl: string; catalogEndpoint: string }> => {
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
  if (
    metadata.resource !== source.resourceIdentifier ||
    !Array.isArray(authorizationServers) ||
    !authorizationServers.includes(source.authorizationServer) ||
    typeof endpointValue !== "string"
  ) {
    throw new CatalogRefreshError("metadata_invalid");
  }
  try {
    const endpoint = new URL(endpointValue);
    const resource = new URL(source.resourceIdentifier);
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
    return { metadataUrl, catalogEndpoint: endpoint.toString() };
  } catch {
    throw new CatalogRefreshError("metadata_invalid");
  }
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

export async function refreshCatalog(
  catalogId: string,
  leaseId: string,
  source: CatalogRefreshSource,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<boolean> {
  const attemptedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const started = performance.now();
  try {
    const { metadataUrl, catalogEndpoint } = await fetchMetadata(source, fetcher);
    const catalog = await fetchCatalog(source, catalogEndpoint, fetcher, attemptedAt);
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
          version: true,
          key: true,
        },
      });
      if (
        !currentResource?.enabled ||
        !currentResource.skillDiscoveryEnabled ||
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
      if (catalog.skills.length) {
        await tx.discoveredSkill.createMany({
          data: catalog.skills.map((skill) => ({
            catalogId,
            localId: skill.id,
            canonicalId: `${source.key}.${skill.id}`,
            title: skill.title,
            content: skill.content,
            requiredScopes: skill.requiredScopes,
            visibility: skill.visibility,
            ...(skill.meta ? { meta: { ...skill.meta } } : {}),
            ...(skill.lastUpdatedAt !== undefined ? { lastUpdatedAt: skill.lastUpdatedAt } : {}),
          })),
        });
      }
      const updated = await tx.discoveredSkillCatalog.updateMany({
        where: { id: catalogId, refreshLeaseId: leaseId },
        data: {
          sourceResourceVersion: source.version,
          schemaVersion: catalog.schemaVersion,
          metadataUrl,
          catalogEndpoint,
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
      if (updated.count !== 1) throw new Error("Skill catalog refresh lease was lost");
      return true;
    });
    if (persisted) {
      logger.info(
        {
          event: "skill_catalog.refresh.succeeded",
          publisherId: source.id,
          publisherKey: source.key,
          resourceVersion: source.version,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          skillCount: catalog.skills.length,
        },
        "Skill catalog refresh succeeded",
      );
    }
    return persisted;
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
      "Skill catalog refresh failed",
    );
    return false;
  }
}

export type ResourceCatalogRefreshOutcome =
  "succeeded" | "failed" | "already_running" | "unavailable";

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
    },
  });
  if (!resource?.enabled || !resource.skillDiscoveryEnabled) return "unavailable";

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

  const succeeded = await refreshCatalog(catalog.id, leaseId, resource, {
    ...options,
    now,
  });
  return succeeded ? "succeeded" : "failed";
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
      resource: { enabled: true, skillDiscoveryEnabled: true },
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
