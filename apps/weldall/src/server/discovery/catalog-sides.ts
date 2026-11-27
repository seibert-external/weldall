import { db, type Prisma } from "@weldall/db";
import { effectiveScopesFor } from "../policy/resources";
import type { PagedCatalog, PagedCatalogKind } from "./paged-catalog";

/**
 * The sides of a resource's catalog besides its skills: shared agents and apps. Each is switched on
 * on its own (`agentDiscoveryEnabled`, `appDiscoveryEnabled`), read with the skills in one refresh
 * (`skills/catalogs.ts`), and kept apart from the skills and from each other: its own columns of
 * `DiscoveredSkillCatalog` (`<kind>SourceResourceVersion`, ...) say when it was last stored and why
 * its last read failed, so a side that cannot be read never takes the skills or another side
 * offline. What differs per kind is small: the catalog it reads (`PagedCatalog`), how its items
 * become rows, and anything else it takes from the metadata (`CatalogSide`).
 */
export type CatalogSideKind = PagedCatalogKind;

/** In the order a refresh reads them and messages name them. */
export const CATALOG_SIDE_KINDS = ["agents", "apps"] as const satisfies readonly CatalogSideKind[];

/** The switch of a resource that turns a side on. */
export const SIDE_SWITCH = {
  agents: "agentDiscoveryEnabled",
  apps: "appDiscoveryEnabled",
} as const satisfies Record<CatalogSideKind, keyof Prisma.DownstreamResourceSelect>;

/** How messages and logs name one item of a side. */
export const SIDE_ITEM = { agents: "agent", apps: "app" } as const satisfies Record<
  CatalogSideKind,
  string
>;

/** A resource with this side switched on (and the resource itself enabled). */
export const sideOnWhere = (kind: CatalogSideKind): Prisma.DownstreamResourceWhereInput =>
  kind === "agents"
    ? { enabled: true, agentDiscoveryEnabled: true }
    : { enabled: true, appDiscoveryEnabled: true };

/** What the catalog row records about one side. */
export interface SideState {
  /** The resource version the stored copy was read for. */
  sourceResourceVersion: number | null;
  lastSuccessfulRefreshAt: Date | null;
  /** Until when the stored copy may be shown. */
  staleAfter: Date | null;
  lastFailureCategory: string | null;
  lastFailureAt: Date | null;
  /** Items of the stored copy that failed validation and were left out. */
  skippedCount: number;
}
const SIDE_FIELDS = [
  "sourceResourceVersion",
  "lastSuccessfulRefreshAt",
  "staleAfter",
  "lastFailureCategory",
  "lastFailureAt",
  "skippedCount",
] as const satisfies ReadonlyArray<keyof SideState>;

/** The columns of a side, e.g. `agentsStaleAfter` and `appsStaleAfter`. */
export type SideColumns<K extends CatalogSideKind> = {
  [F in keyof SideState as `${K}${Capitalize<F>}`]: SideState[F];
};
const columnName = (kind: CatalogSideKind, field: keyof SideState) =>
  `${kind}${field[0]!.toUpperCase()}${field.slice(1)}`;

export function sideColumnsSelect<K extends CatalogSideKind>(
  kind: K,
): { [C in keyof SideColumns<K>]: true } {
  return Object.fromEntries(SIDE_FIELDS.map((field) => [columnName(kind, field), true])) as {
    [C in keyof SideColumns<K>]: true;
  };
}

export function sideState<K extends CatalogSideKind>(kind: K, catalog: SideColumns<K>): SideState {
  const row = catalog as unknown as Record<string, unknown>;
  return Object.fromEntries(
    SIDE_FIELDS.map((field) => [field, row[columnName(kind, field)]]),
  ) as unknown as SideState;
}

/** The catalog columns that store `state` for this side. */
export function sideColumns<K extends CatalogSideKind>(
  kind: K,
  state: Partial<SideState>,
): Partial<SideColumns<K>> {
  return Object.fromEntries(
    Object.entries(state).map(([field, value]) => [
      columnName(kind, field as keyof SideState),
      value,
    ]),
  ) as Partial<SideColumns<K>>;
}

/**
 * The state of one side's copy, by the freshness rules of discovered skills (`skills/service.ts`).
 * - `fresh` / `stale`: the items are shown; `stale` means a refresh is due.
 * - `failed`: the last refresh could not read this side (or failed as a whole); while the last copy
 *   is younger than a day it is still shown, otherwise the state is `expired`.
 * - `expired`: people do not see the items: the copy is older than a day, or it was read before the
 *   resource was last changed and is shown again after the next refresh.
 * - `pending`: never read yet. `disabled`: the resource or this side's discovery is off.
 */
export type CatalogSideState = "disabled" | "pending" | "fresh" | "stale" | "failed" | "expired";

export interface CatalogSideStatus {
  state: CatalogSideState;
  lastSuccessfulRefreshAt: string | null;
  /**
   * Why the last refresh did not read this side: the refresh failed as a whole (its category), or
   * only this side failed (`<kind>LastFailureCategory`); null when it did not fail.
   */
  lastFailureCategory: string | null;
  lastFailureAt: string | null;
  /** Items of the last stored copy that failed validation and were left out. */
  skippedCount: number;
}

/** The catalog columns `catalogSideStatus` reads for a side. */
export const sideStatusSelect = <K extends CatalogSideKind>(kind: K) => ({
  nextRefreshAt: true as const,
  lastFailureCategory: true as const,
  lastFailureAt: true as const,
  ...sideColumnsSelect(kind),
});

export type SideStatusColumns<K extends CatalogSideKind> = {
  nextRefreshAt: Date;
  lastFailureCategory: string | null;
  lastFailureAt: Date | null;
} & SideColumns<K>;

export function catalogSideStatus<K extends CatalogSideKind>(
  kind: K,
  resource: { enabled: boolean; version: number } & Record<(typeof SIDE_SWITCH)[K], boolean>,
  catalog: SideStatusColumns<K> | null,
  now: Date = new Date(),
): CatalogSideStatus {
  const side = catalog ? sideState(kind, catalog) : null;
  const switchedOn = (resource as Record<string, unknown>)[SIDE_SWITCH[kind]] === true;
  // A refresh that failed as a whole did not read this side either. It is the more recent failure:
  // a refresh whose skill side is stored clears it.
  const failure = catalog?.lastFailureCategory
    ? { category: catalog.lastFailureCategory, at: catalog.lastFailureAt }
    : side?.lastFailureCategory
      ? { category: side.lastFailureCategory, at: side.lastFailureAt }
      : null;
  const failed = failure !== null;
  const state: CatalogSideState =
    !resource.enabled || !switchedOn
      ? "disabled"
      : !catalog || !side?.lastSuccessfulRefreshAt
        ? failed
          ? "failed"
          : "pending"
        : !side.staleAfter ||
            side.staleAfter <= now ||
            side.sourceResourceVersion !== resource.version
          ? "expired"
          : failed
            ? "failed"
            : catalog.nextRefreshAt <= now
              ? "stale"
              : "fresh";
  return {
    state,
    lastSuccessfulRefreshAt: side?.lastSuccessfulRefreshAt?.toISOString() ?? null,
    lastFailureCategory: failure?.category ?? null,
    lastFailureAt: failure?.at?.toISOString() ?? null,
    skippedCount: side?.skippedCount ?? 0,
  };
}

/** From the least healthy up: what a resource that discovers several sides but no skills shows. */
const HEALTH: readonly CatalogSideState[] = [
  "expired",
  "failed",
  "pending",
  "stale",
  "fresh",
  "disabled",
];
export const leastHealthy = (states: readonly CatalogSideState[]): CatalogSideState =>
  HEALTH.find((state) => states.includes(state)) ?? "disabled";

type StateWarningCode = "catalog_pending" | "catalog_temporarily_unavailable" | "catalog_expired";

/** Shown to administrators only. */
export type CatalogSideWarning<K extends CatalogSideKind> =
  | { source: string; code: StateWarningCode }
  | {
      source: string;
      /** The resource published items that failed validation; they were left out. */
      code: `${K}_skipped`;
      count: number;
    };

/** People see the items of a side in these states (`catalogSideStatus`). */
const SHOWN_STATES: ReadonlySet<CatalogSideState> = new Set(["fresh", "stale", "failed"]);
/** The warning an administrator gets for a side in this state; none for the others. */
const stateWarnings: Partial<Record<CatalogSideState, StateWarningCode>> = {
  pending: "catalog_pending",
  failed: "catalog_temporarily_unavailable",
  expired: "catalog_expired",
};

/**
 * Whether people see the items of a resource's side, and what an administrator is told about it
 * (`canViewIssues`).
 */
export function sideVisibility<K extends CatalogSideKind>(
  kind: K,
  source: string,
  status: CatalogSideStatus,
  canViewIssues: boolean,
): { shown: boolean; warnings: Array<CatalogSideWarning<K>> } {
  const warnings: Array<CatalogSideWarning<K>> = [];
  const warning = stateWarnings[status.state];
  if (canViewIssues && warning) warnings.push({ source, code: warning });
  const shown = SHOWN_STATES.has(status.state);
  if (shown && canViewIssues && status.skippedCount)
    warnings.push({ source, code: `${kind}_skipped`, count: status.skippedCount });
  return { shown, warnings };
}

/**
 * The permissions that open an item for this person: the ones they hold, except Weldall's own.
 * An item's scopes widen who sees it, and Weldall takes them from the resource as reported, so
 * Weldall's own permissions (administration, login, ...) never open one: no resource can address
 * administrators or simply everyone.
 */
export async function openingScopes(
  email: string,
): Promise<{ grants: Set<string>; scopes: Array<{ key: string; description: string }> }> {
  const grants = new Set<string>(await effectiveScopesFor(email));
  const scopes = await db.scope.findMany({
    where: { key: { in: [...grants] }, isSystem: false },
    orderBy: { key: "asc" },
    select: { key: true, description: true },
  });
  return { grants, scopes };
}

/** Display name and email of the people an item names as its owner, by user id. */
export async function usersById(ids: Iterable<string | null>) {
  const unique = [...new Set([...ids].filter((id): id is string => id !== null))];
  const users = unique.length
    ? await db.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true, email: true },
      })
    : [];
  return new Map(users.map((user) => [user.id, user]));
}

/** True when an enabled resource has this side switched on: the directory shows its tab. */
export async function sideOffered(kind: CatalogSideKind): Promise<boolean> {
  return (await db.downstreamResource.count({ where: sideOnWhere(kind) })) > 0;
}

/** The page of an administrator's list, clamped as the admin skill list clamps it. */
export const pageWindow = (input: { page: number; pageSize: number }) => {
  const page = Math.max(1, Math.trunc(input.page) || 1);
  const pageSize = Math.min(Math.max(1, Math.trunc(input.pageSize) || 20), 200);
  return { skip: (page - 1) * pageSize, take: pageSize };
};

type CatalogUpdate = Prisma.DiscoveredSkillCatalogUpdateManyMutationInput;

/** What a side may check values from the metadata against: the resource as registered in Weldall. */
export interface SideRegistration {
  resourceIdentifier: string;
  /** The resource's own scopes; `isSystem` marks Weldall's own permissions. */
  scopes: ReadonlyArray<{ key: string; isSystem: boolean }>;
}

/**
 * What a refresh needs to know about one side. Method syntax keeps a side of any item type usable
 * where the refresh handles all sides alike.
 */
export interface CatalogSide<K extends CatalogSideKind, Item> {
  kind: K;
  catalog: PagedCatalog<K, Item>;
  /**
   * Anything else the side takes from the metadata, as catalog columns stored when the side was
   * read; throws when it is malformed, which fails the side as metadata without its endpoint does.
   * `endpoint` checks a URL the metadata names as Weldall checks the side's endpoint.
   */
  metadata?(metadata: Record<string, unknown>, endpoint: (value: string) => string): CatalogUpdate;
  /**
   * Values the side takes from the metadata apart from its items: stored whenever the metadata was
   * read with the side switched on, whatever happens afterwards to the skill side (no skill
   * endpoint, a skill catalog that cannot be read), to the other sides or to its own items, and
   * never failing the side (a value that does not pass is stored as refused). `now` is when the
   * refresh started. When the metadata cannot be read at all, the stored values stay as they were.
   */
  settings?(
    metadata: Record<string, unknown>,
    registration: SideRegistration,
    now: Date,
  ): CatalogUpdate;
  /** The catalog columns `settingsChanged` reads of the row as it was before. */
  settingsSelect?: Record<string, true>;
  /**
   * Called after `settings` were stored, with the row's columns of `settingsSelect` as they were
   * before and the update that replaced them: where the side records a change that matters.
   */
  settingsChanged?(
    before: Record<string, unknown>,
    after: CatalogUpdate,
    resource: { id: string; key: string; version: number },
  ): void;
  /** What `metadata` and `settings` store, cleared while the side is switched off. */
  clearedMetadata?: CatalogUpdate;
  /** Removes every stored item of the catalog. */
  remove(tx: Prisma.TransactionClient, catalogId: string): Promise<unknown>;
  /** Stores one batch of items read from the resource with this key. */
  insert(
    tx: Prisma.TransactionClient,
    catalogId: string,
    resourceKey: string,
    items: Item[],
  ): Promise<unknown>;
}
