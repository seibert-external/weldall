import { randomUUID } from "node:crypto";
import { db, type Prisma } from "@weldall/db";
import { parseSkillCatalog, SKILL_ASSERTION_TYPE, type SkillCatalog } from "@weldall/sdk";
import { agentSide } from "../agents/discovery";
import { appSide } from "../apps/discovery";
import {
  CATALOG_SIDE_KINDS,
  SIDE_ITEM,
  SIDE_SWITCH,
  sideColumns,
  sideColumnsSelect,
  sideState,
  type CatalogSide,
  type CatalogSideKind,
  type SideState,
} from "../discovery/catalog-sides";
import { PagedCatalogError, type PagedCatalogFailureCategory } from "../discovery/paged-catalog";
import { WELDALL_ISSUER } from "../oauth/constants";
import { listing } from "../../lib/listing";
import { signWeldallJwt } from "../oauth/jwt";
import { errorForLog, logger } from "../observability/logger";

const REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
const MAX_STALE_MS = 24 * 60 * 60 * 1_000;
const LEASE_MS = 30_000;
/** Each of the metadata and skill catalog requests. */
const FETCH_TIMEOUT_MS = 5_000;
/**
 * Prisma's wait for a connection before the refresh transaction starts; the transaction renews the
 * lease as its first statement, so this wait still counts against the lease of the reads.
 */
const TRANSACTION_MAX_WAIT_MS = 2_000;
/** What is left of the lease when the transaction renews it at the latest. */
const LEASE_MARGIN_MS = 5_000;
/**
 * Everything a refresh reads, from its start until every side is read: the metadata and the skill
 * catalog have their own timeouts within it, and the sides share whatever remains of it (one
 * deadline for all of them, read at the same time). So the reads end before the lease does however
 * many sides there are, and the transaction that stores them renews it before it runs out.
 */
const READ_BUDGET_MS = LEASE_MS - TRANSACTION_MAX_WAIT_MS - LEASE_MARGIN_MS;
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
 * Why only one side of a refresh failed (`<kind>LastFailureCategory`). The skill side is stored all
 * the same, and the side is left as it was. `refresh_internal_error`: the items were read but could
 * not be stored.
 */
export type SideRefreshFailureCategory =
  PagedCatalogFailureCategory<CatalogSideKind> | "refresh_internal_error";

export interface CatalogRefreshSource {
  id: string;
  key: string;
  resourceIdentifier: string;
  authorizationServer: string;
  version: number;
  /** What the administrator allowed this resource to publish; at least one of them is on. */
  skillDiscoveryEnabled: boolean;
  agentDiscoveryEnabled: boolean;
  appDiscoveryEnabled: boolean;
}

/** Every side besides the skills, in `CATALOG_SIDE_KINDS` order. */
const SIDES: ReadonlyArray<CatalogSide<CatalogSideKind, unknown>> = [agentSide, appSide];

const sideOn = (source: CatalogRefreshSource, kind: CatalogSideKind): boolean =>
  source[SIDE_SWITCH[kind]];

class CatalogRefreshError extends Error {
  constructor(readonly category: CatalogFailureCategory) {
    super(category);
  }
}

/** What the log calls a refresh: by what it reads (skills, agents, apps, or several of them). */
const catalogLabel = (source: CatalogRefreshSource): string => {
  const label =
    listing([
      ...(source.skillDiscoveryEnabled ? ["skill"] : []),
      ...CATALOG_SIDE_KINDS.filter((kind) => sideOn(source, kind)).map((kind) => SIDE_ITEM[kind]),
    ]) || "skill";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} catalog`;
};

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
 * Where a side reads, from the metadata, and what else it stores from it. Metadata that names no
 * usable endpoint for a side fails only that side, so it is answered as a failure rather than thrown.
 */
type SideTarget =
  | { endpoint: string; metadata: Prisma.DiscoveredSkillCatalogUpdateManyMutationInput }
  | { failure: SideRefreshFailureCategory };

const sideTarget = (
  side: CatalogSide<CatalogSideKind, unknown>,
  metadata: Record<string, unknown>,
  resourceIdentifier: string,
): SideTarget => {
  try {
    const value = metadata[side.catalog.metadataKey];
    if (typeof value !== "string") throw new TypeError(`no ${SIDE_ITEM[side.kind]} endpoint`);
    const endpoint = (url: string) => safeEndpoint(url, resourceIdentifier);
    return {
      endpoint: endpoint(value),
      metadata: side.metadata?.(metadata, endpoint) ?? {},
    };
  } catch {
    return { failure: `${side.kind}_metadata_invalid` };
  }
};

const fetchMetadata = async (
  source: CatalogRefreshSource,
  fetcher: typeof fetch,
): Promise<{
  metadataUrl: string;
  catalogEndpoint: string | null;
  /** By side; a side that is switched off has none. */
  targets: Partial<Record<CatalogSideKind, SideTarget>>;
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
  const targets: Partial<Record<CatalogSideKind, SideTarget>> = {};
  for (const side of SIDES)
    if (sideOn(source, side.kind))
      targets[side.kind] = sideTarget(side, metadata, source.resourceIdentifier);
  return { metadataUrl, catalogEndpoint, targets };
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

/** One side of a refresh; reading it never throws, so it cannot fail the skill side or another. */
type SideRead =
  | {
      ok: true;
      items: unknown[];
      skipped: number;
      metadata: Prisma.DiscoveredSkillCatalogUpdateManyMutationInput;
    }
  | { ok: false; category: SideRefreshFailureCategory; error?: unknown };

const readSide = async (
  side: CatalogSide<CatalogSideKind, unknown>,
  source: CatalogRefreshSource,
  target: SideTarget,
  fetcher: typeof fetch,
  now: Date,
  deadline: AbortSignal,
): Promise<SideRead> => {
  if ("failure" in target) return { ok: false, category: target.failure };
  const unavailable: SideRead = { ok: false, category: `${side.kind}_unavailable` };
  // The deadline ends the read even when a request does not heed its signal.
  let stop = () => {};
  const timedOut = new Promise<SideRead>((resolve) => {
    stop = () => resolve(unavailable);
    if (deadline.aborted) stop();
    else deadline.addEventListener("abort", stop, { once: true });
  });
  const reading = side.catalog
    .fetch({
      resourceIdentifier: source.resourceIdentifier,
      endpoint: target.endpoint,
      fetcher,
      now,
      readJson: readBoundedJson,
      signal: deadline,
    })
    .then(
      ({ items, skipped }): SideRead => ({ ok: true, items, skipped, metadata: target.metadata }),
      (error: unknown): SideRead =>
        // A body cut off by the deadline is not a malformed page.
        deadline.aborted
          ? unavailable
          : error instanceof PagedCatalogError
            ? { ok: false, category: (error as PagedCatalogError<CatalogSideKind>).category }
            : { ok: false, category: "refresh_internal_error", error },
    );
  try {
    return await Promise.race([reading, timedOut]);
  } finally {
    deadline.removeEventListener("abort", stop);
  }
};

/**
 * Reads every side that is switched on at the same time, under one deadline: what is left of the
 * read budget after the metadata and the skill catalog. Each side has its own outcome; one that
 * fails or runs into the deadline does not end or fail another.
 */
async function readSides(
  source: CatalogRefreshSource,
  targets: Partial<Record<CatalogSideKind, SideTarget>>,
  fetcher: typeof fetch,
  now: Date,
  remainingMs: number,
): Promise<Map<CatalogSideKind, SideRead>> {
  const sides = SIDES.filter((side) => targets[side.kind] !== undefined);
  if (!sides.length) return new Map();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(0, remainingMs));
  try {
    const reads = await Promise.all(
      sides.map(
        async (side) =>
          [
            side.kind,
            await readSide(side, source, targets[side.kind]!, fetcher, now, deadline.signal),
          ] as const,
      ),
    );
    return new Map(reads);
  } finally {
    clearTimeout(timer);
  }
}

const SIDE_INSERT_BATCH = 200;
/**
 * Room for large agent and app catalogs. The transaction renews the lease as its first statement
 * and holds the row from then on, so once it has started it cannot lose the lease: another refresh
 * that tries to claim it waits for the row and then finds the renewed lease. What can run out is
 * only the time before that statement, which `READ_BUDGET_MS` bounds.
 */
const PERSIST_TRANSACTION = { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: 15_000 } as const;

/** The timing a refresh relies on to keep its lease (pinned in tests). */
export const REFRESH_TIMING = {
  leaseMs: LEASE_MS,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  readBudgetMs: READ_BUDGET_MS,
  transactionMaxWaitMs: TRANSACTION_MAX_WAIT_MS,
  transactionTimeoutMs: PERSIST_TRANSACTION.timeout,
} as const;

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
 * Stores the items of a side that were read, replacing its last copy. It runs in a savepoint of the
 * refresh transaction: when the write fails (a value the database refuses that validation let
 * through, a constraint), only this side is rolled back, and the refresh records a failure of this
 * side with the skills and the other sides stored and the last copy of this side kept.
 */
async function replaceSide(
  tx: Prisma.TransactionClient,
  side: CatalogSide<CatalogSideKind, unknown>,
  catalogId: string,
  source: CatalogRefreshSource,
  read: Extract<SideRead, { ok: true }>,
): Promise<SideRead> {
  // The sides are written one after another, so they can share the savepoint's name.
  await tx.$executeRaw`SAVEPOINT catalog_side`;
  try {
    await side.remove(tx, catalogId);
    for (let start = 0; start < read.items.length; start += SIDE_INSERT_BATCH)
      await side.insert(
        tx,
        catalogId,
        source.key,
        read.items.slice(start, start + SIDE_INSERT_BATCH),
      );
  } catch (error) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT catalog_side`;
    await tx.$executeRaw`RELEASE SAVEPOINT catalog_side`;
    return { ok: false, category: "refresh_internal_error", error };
  }
  await tx.$executeRaw`RELEASE SAVEPOINT catalog_side`;
  return read;
}

/**
 * What people see of a side after a refresh in which it failed: the last copy (`kept`), nothing
 * because the copy is too old or from before the resource was changed (`hidden`), or nothing
 * because nothing was read yet (`none`). Mirrors `catalogSideStatus`.
 */
export type SideCopyState = "kept" | "hidden" | "none";

function sideCopyState(side: SideState, resourceVersion: number, now: Date): SideCopyState {
  if (!side.lastSuccessfulRefreshAt) return "none";
  return !side.staleAfter ||
    side.staleAfter <= now ||
    side.sourceResourceVersion !== resourceVersion
    ? "hidden"
    : "kept";
}

const sideCopyMessage = (kind: CatalogSideKind, copy: SideCopyState): string =>
  copy === "kept"
    ? `the ${kind} keep their last copy`
    : copy === "hidden"
      ? `the last copy of the ${kind} stays hidden until they are read again`
      : `no ${kind} have been read yet`;

/**
 * `<kinds>_failed`: these sides failed and were left as they were; the skill side (if the resource
 * has one) and every other side were stored.
 * `failed`: nothing was stored (the refresh failed as a whole, or the resource changed meanwhile).
 */
export type CatalogSideFailure = "agents_failed" | "apps_failed" | "agents_and_apps_failed";
export type CatalogRefreshResult = "succeeded" | CatalogSideFailure | "failed";

const capitalized = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

export interface CatalogRefreshOptions {
  fetcher?: typeof fetch;
  now?: Date;
  /** Shortens the read budget (`READ_BUDGET_MS`), for tests; it is never lengthened. */
  readBudgetMs?: number;
}

/** The transaction found the lease held by another refresh: nothing was stored. */
const LEASE_LOST = Symbol("lease lost");

export async function refreshCatalog(
  catalogId: string,
  leaseId: string,
  source: CatalogRefreshSource,
  options: CatalogRefreshOptions = {},
): Promise<CatalogRefreshResult> {
  const attemptedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const started = performance.now();
  const elapsedMs = () => Math.max(0, Math.round(performance.now() - started));
  const readBudgetMs = Math.min(options.readBudgetMs ?? READ_BUDGET_MS, READ_BUDGET_MS);
  try {
    const { metadataUrl, catalogEndpoint, targets } = await fetchMetadata(source, fetcher);
    const catalog = catalogEndpoint
      ? await fetchCatalog(source, catalogEndpoint, fetcher, attemptedAt)
      : null;
    // The skill side above fails the refresh as it would without the other sides. Every other side
    // has its own outcome: when it fails, the rest is stored all the same and it keeps its copy.
    const reads = await readSides(
      source,
      targets,
      fetcher,
      attemptedAt,
      readBudgetMs - (performance.now() - started),
    );
    const readMs = elapsedMs();
    const persisted = await db.$transaction(async (tx) => {
      const lease = await tx.discoveredSkillCatalog.updateMany({
        where: { id: catalogId, refreshLeaseId: leaseId },
        data: { refreshLeaseUntil: new Date(Date.now() + LEASE_MS) },
      });
      if (lease.count !== 1) return LEASE_LOST;
      const currentResource = await tx.downstreamResource.findUnique({
        where: { id: source.id },
        select: {
          enabled: true,
          skillDiscoveryEnabled: true,
          agentDiscoveryEnabled: true,
          appDiscoveryEnabled: true,
          version: true,
          key: true,
        },
      });
      if (
        !currentResource?.enabled ||
        currentResource.skillDiscoveryEnabled !== source.skillDiscoveryEnabled ||
        CATALOG_SIDE_KINDS.some(
          (kind) => currentResource[SIDE_SWITCH[kind]] !== sideOn(source, kind),
        ) ||
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
        return null;
      }
      const previous = await tx.discoveredSkillCatalog.findUniqueOrThrow({
        where: { id: catalogId },
        select: {
          retryCount: true,
          ...sideColumnsSelect("agents"),
          ...sideColumnsSelect("apps"),
        },
      });
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
      // A side is removed when it is switched off, replaced when read, kept when it could not be.
      const outcomes: Array<{
        side: CatalogSide<CatalogSideKind, unknown>;
        outcome: SideRead | null;
        copy: SideCopyState;
      }> = [];
      for (const side of SIDES) {
        const read = reads.get(side.kind) ?? null;
        let outcome = read;
        if (read === null) await side.remove(tx, catalogId);
        else if (read.ok) outcome = await replaceSide(tx, side, catalogId, source, read);
        outcomes.push({
          side,
          outcome,
          copy: sideCopyState(sideState(side.kind, previous), source.version, attemptedAt),
        });
      }
      const on = outcomes.filter(({ outcome }) => outcome !== null);
      // Without a skill side the other sides are the whole refresh: when every one of them failed,
      // it is retried as a failed refresh is. Otherwise the stored part decides when the next is due.
      const failedAsWhole =
        !source.skillDiscoveryEnabled && on.every(({ outcome }) => outcome?.ok === false);
      const updated = await tx.discoveredSkillCatalog.updateMany({
        where: { id: catalogId, refreshLeaseId: leaseId },
        data: {
          sourceResourceVersion: source.version,
          schemaVersion: catalog?.schemaVersion ?? null,
          metadataUrl,
          catalogEndpoint,
          ...Object.assign(
            {},
            ...outcomes.map(({ side, outcome }) =>
              sideUpdate(side, outcome, source.version, attemptedAt),
            ),
          ),
          lastAttemptAt: attemptedAt,
          ...(failedAsWhole
            ? {
                retryCount: { increment: 1 },
                nextRefreshAt: new Date(
                  attemptedAt.getTime() + failureBackoffMs(previous.retryCount),
                ),
              }
            : {
                lastSuccessfulRefreshAt: attemptedAt,
                staleAfter: new Date(attemptedAt.getTime() + MAX_STALE_MS),
                retryCount: 0,
                nextRefreshAt: new Date(attemptedAt.getTime() + REFRESH_INTERVAL_MS),
              }),
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          lastFailureCategory: null,
          lastFailureAt: null,
        },
      });
      if (updated.count !== 1) throw new Error(`${catalogLabel(source)} refresh lease was lost`);
      return on;
    }, PERSIST_TRANSACTION);
    if (persisted === LEASE_LOST) {
      // The lease ran out and another refresh claimed it (or the catalog is gone). That refresh
      // records its own outcome; this one is not a failure of the resource, so it is only logged.
      logger.warn(
        {
          event: "skill_catalog.refresh.lease_lost",
          publisherId: source.id,
          publisherKey: source.key,
          resourceVersion: source.version,
          readDurationMs: readMs,
          durationMs: elapsedMs(),
          leaseMs: LEASE_MS,
        },
        `${catalogLabel(source)} refresh lost its lease before it could store what it read; nothing was stored`,
      );
      return "failed";
    }
    if (!persisted) return "failed";
    const stored = persisted.filter(({ outcome }) => outcome?.ok);
    const failed = persisted.filter(({ outcome }) => outcome?.ok === false);
    const storedNames = [
      ...(source.skillDiscoveryEnabled ? ["skills"] : []),
      ...stored.map(({ side }) => side.kind),
    ];
    if (storedNames.length)
      logger.info(
        {
          event: "skill_catalog.refresh.succeeded",
          publisherId: source.id,
          publisherKey: source.key,
          resourceVersion: source.version,
          durationMs: elapsedMs(),
          skillCount: catalog?.skills.length ?? 0,
          ...Object.assign(
            {},
            ...stored.map(({ side, outcome }) => {
              const item = capitalized(SIDE_ITEM[side.kind]);
              const read = outcome as Extract<SideRead, { ok: true }>;
              return {
                [`${SIDE_ITEM[side.kind]}Count`]: read.items.length,
                [`skipped${item}Count`]: read.skipped,
              };
            }),
          ),
        },
        failed.length
          ? `${catalogLabel(source)} refresh stored the ${listing(storedNames)}; the ${listing(
              failed.map(({ side }) => side.kind),
            )} could not be read`
          : `${catalogLabel(source)} refresh succeeded`,
      );
    for (const { side, outcome, copy } of failed) {
      if (outcome?.ok !== false) continue;
      logger.warn(
        {
          event: `${SIDE_ITEM[side.kind]}_catalog.refresh.failed`,
          publisherId: source.id,
          publisherKey: source.key,
          resourceVersion: source.version,
          failureCategory: outcome.category,
          [`${SIDE_ITEM[side.kind]}Copy`]: copy,
          durationMs: elapsedMs(),
          ...(outcome.error === undefined ? {} : { error: errorForLog(outcome.error) }),
        },
        `${capitalized(SIDE_ITEM[side.kind])} catalog refresh failed; ${sideCopyMessage(side.kind, copy)}`,
      );
    }
    return failed.length
      ? (`${failed.map(({ side }) => side.kind).join("_and_")}_failed` as CatalogSideFailure)
      : "succeeded";
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
        durationMs: elapsedMs(),
        error: errorForLog(error),
      },
      `${catalogLabel(source)} refresh failed`,
    );
    return "failed";
  }
}

/** A side's columns of the catalog row after a refresh whose skill side (if any) was stored. */
function sideUpdate(
  side: CatalogSide<CatalogSideKind, unknown>,
  read: SideRead | null,
  resourceVersion: number,
  attemptedAt: Date,
): Prisma.DiscoveredSkillCatalogUpdateManyMutationInput {
  if (read === null)
    return {
      ...side.clearedMetadata,
      ...sideColumns(side.kind, {
        sourceResourceVersion: null,
        lastSuccessfulRefreshAt: null,
        staleAfter: null,
        lastFailureCategory: null,
        lastFailureAt: null,
        skippedCount: 0,
      }),
    };
  if (!read.ok)
    return sideColumns(side.kind, {
      lastFailureCategory: read.category,
      lastFailureAt: attemptedAt,
    });
  return {
    ...read.metadata,
    ...sideColumns(side.kind, {
      sourceResourceVersion: resourceVersion,
      lastSuccessfulRefreshAt: attemptedAt,
      staleAfter: new Date(attemptedAt.getTime() + MAX_STALE_MS),
      lastFailureCategory: null,
      lastFailureAt: null,
      skippedCount: read.skipped,
    }),
  };
}

export type ResourceCatalogRefreshOutcome =
  CatalogRefreshResult | "already_running" | "unavailable";

export async function refreshResourceCatalog(
  resourceId: string,
  options: CatalogRefreshOptions = {},
): Promise<ResourceCatalogRefreshOutcome> {
  const now = options.now ?? new Date();
  const resource = await db.downstreamResource.findUnique({
    where: { id: resourceId },
    select: refreshSourceSelect,
  });
  if (
    !resource?.enabled ||
    !(resource.skillDiscoveryEnabled || CATALOG_SIDE_KINDS.some((kind) => sideOn(resource, kind)))
  )
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

const refreshSourceSelect = {
  id: true,
  key: true,
  resourceIdentifier: true,
  authorizationServer: true,
  version: true,
  enabled: true,
  skillDiscoveryEnabled: true,
  agentDiscoveryEnabled: true,
  appDiscoveryEnabled: true,
} as const satisfies Prisma.DownstreamResourceSelect;

export async function refreshDueCatalogs(
  options: CatalogRefreshOptions & { limit?: number } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? MAX_REFRESHES_PER_SWEEP, 1), 20);
  const due = await db.discoveredSkillCatalog.findMany({
    where: {
      nextRefreshAt: { lte: now },
      OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }],
      resource: {
        enabled: true,
        OR: [
          { skillDiscoveryEnabled: true },
          { agentDiscoveryEnabled: true },
          { appDiscoveryEnabled: true },
        ],
      },
    },
    orderBy: { nextRefreshAt: "asc" },
    take: limit,
    include: { resource: { select: refreshSourceSelect } },
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
