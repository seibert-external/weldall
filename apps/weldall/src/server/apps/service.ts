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
 * The apps a person may see: discovered apps (`discovery.ts`) they own, or for which they hold any
 * one of the app's scopes. An app the resource reports without owner and without scopes is seen by
 * administrators only, in the admin list. Apps are read-only: Weldall shows where they run and
 * where their code is, and changes nothing.
 */
export interface VisibleApp {
  /** `<resource key>.<id at the resource>`. */
  id: string;
  /** The id at the resource. */
  sourceId: string;
  name: string;
  description: string;
  /** True when the person asking is the app's owner. */
  own: boolean;
  /** False when the resource reports no owner for the app. */
  hasOwner: boolean;
  /** Display name of the owner; null without an owner or when Weldall does not know them. */
  ownerName: string | null;
  scopes: string[];
  /** Null for an app without a Git repository. */
  repository: { name: string; url: string } | null;
  /** Where the app runs (https); null when the resource reports none. */
  url: string | null;
  revision: number;
  /** When the app was created and last changed at the resource, as it reports them. */
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /**
   * Past the review date the resource set (`expiresAt`). Flagged only ("Review due"): the app is
   * listed and its link shown as before, and nothing says why it is due.
   */
  expired: boolean;
  source: { type: "resource"; key: string; name: string };
}

/** Shown to administrators only. */
export type AppWarning = CatalogSideWarning<"apps">;

export interface VisibleAppsEnvelope {
  items: VisibleApp[];
  warnings: AppWarning[];
}

/**
 * The app side of a resource's catalog (`DiscoveredSkillCatalog.apps*`), kept apart from the skill
 * and agent sides; see `CatalogSideState` for the states.
 */
export type AppCatalogState = CatalogSideState;
export type AppCatalogStatus = CatalogSideStatus;

/** The catalog columns `appCatalogStatus` reads. */
export const appCatalogStatusSelect = sideStatusSelect("apps");

export const appCatalogStatus = (
  resource: { enabled: boolean; appDiscoveryEnabled: boolean; version: number },
  catalog: SideStatusColumns<"apps"> | null,
  now: Date = new Date(),
): AppCatalogStatus => catalogSideStatus("apps", resource, catalog, now);

/** The stored repository columns as one value: both set, or no repository. */
const repositoryOf = (row: {
  repositoryName: string | null;
  repositoryUrl: string | null;
}): { name: string; url: string } | null =>
  row.repositoryName !== null && row.repositoryUrl !== null
    ? { name: row.repositoryName, url: row.repositoryUrl }
    : null;

export async function listVisibleApps(user: {
  id: string;
  email: string;
}): Promise<VisibleAppsEnvelope> {
  const { grants, scopes } = await openingScopes(user.email);
  const opening = scopes.map((scope) => scope.key);
  const now = new Date();
  const resources = await db.downstreamResource.findMany({
    where: { enabled: true, appDiscoveryEnabled: true },
    orderBy: { key: "asc" },
    select: {
      key: true,
      name: true,
      version: true,
      enabled: true,
      appDiscoveryEnabled: true,
      discoveredCatalog: {
        select: {
          ...appCatalogStatusSelect,
          apps: {
            where: { OR: [{ ownerId: user.id }, { scopes: { hasSome: opening } }] },
            orderBy: [{ name: "asc" }, { canonicalId: "asc" }],
          },
        },
      },
    },
  });
  const canViewCatalogIssues = grants.has(ADMIN_SCOPE_KEY);
  const warnings: AppWarning[] = [];
  const visible: Array<{
    resource: (typeof resources)[number];
    app: NonNullable<(typeof resources)[number]["discoveredCatalog"]>["apps"][number];
  }> = [];
  for (const resource of resources) {
    const catalog = resource.discoveredCatalog;
    const status = appCatalogStatus(resource, catalog, now);
    const { shown, warnings: issues } = sideVisibility(
      "apps",
      resource.key,
      status,
      canViewCatalogIssues,
    );
    warnings.push(...issues);
    if (!catalog || !shown) continue;
    for (const app of catalog.apps) visible.push({ resource, app });
  }

  const owners = await usersById(visible.map(({ app }) => app.ownerId));

  return {
    items: visible
      .map(({ resource, app }): VisibleApp => ({
        id: app.canonicalId,
        sourceId: app.localId,
        name: app.name,
        description: app.description,
        own: app.ownerId !== null && app.ownerId === user.id,
        hasOwner: app.ownerId !== null,
        ownerName: (app.ownerId && owners.get(app.ownerId)?.name) ?? null,
        scopes: app.scopes,
        repository: repositoryOf(app),
        url: app.url,
        revision: app.revision,
        createdAt: app.sourceCreatedAt.toISOString(),
        updatedAt: app.sourceUpdatedAt.toISOString(),
        expiresAt: app.expiresAt.toISOString(),
        expired: app.expiresAt <= now,
        source: { type: "resource", key: resource.key, name: resource.name },
      }))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
    warnings,
  };
}

/** How the directory names an app's owner. */
export const ownerLabel = (app: Pick<VisibleApp, "own" | "hasOwner" | "ownerName">): string =>
  app.own ? "You" : !app.hasOwner ? "No owner" : (app.ownerName ?? "Unknown");

/** One app the person may see, by its id (`<resource key>.<id at the resource>`). */
export async function getVisibleApp(
  user: { id: string; email: string },
  id: string,
): Promise<VisibleApp | null> {
  return (await listVisibleApps(user)).items.find((app) => app.id === id) ?? null;
}

/**
 * True when an enabled resource has app discovery switched on: only then can apps come from
 * anywhere, and the directory shows its Apps tab.
 */
export const appsOffered = (): Promise<boolean> => sideOffered("apps");

/** A discovered app as an administrator sees it: every app, whoever it is shared with. */
export interface AdminAppDto {
  id: string;
  name: string;
  description: string;
  /** As the resource reported it; null when it reports no owner. */
  ownerId: string | null;
  /** Null without an owner or when Weldall does not know the owner. */
  ownerName: string | null;
  ownerEmail: string | null;
  scopes: string[];
  /** Null for an app without a Git repository. */
  repository: { name: string; url: string } | null;
  url: string | null;
  revision: number;
  /** As the resource reports them. */
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  resource: { id: string; key: string; name: string };
  /**
   * The state of the copy the app comes from (`appCatalogStatus`); in `expired` (and `pending`)
   * people do not see it, though it is still stored.
   */
  catalogState: AppCatalogState;
}

/**
 * Apps of resources whose app discovery is on, by name. `source` is a resource id. Like the admin
 * agent list, it also lists apps people cannot see at the moment and says so per row
 * (`catalogState`).
 */
export async function listDiscoveredApps(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  source?: string | undefined;
}): Promise<{ items: AdminAppDto[]; total: number }> {
  const q = input.q?.trim();
  const where: Prisma.DiscoveredAppWhereInput = {
    catalog: {
      resource: {
        enabled: true,
        appDiscoveryEnabled: true,
        ...(input.source ? { id: input.source } : {}),
      },
    },
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
            { repositoryName: { contains: q, mode: "insensitive" } },
            { scopes: { has: q } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.discoveredApp.findMany({
      where,
      orderBy: [{ name: "asc" }, { canonicalId: "asc" }],
      ...pageWindow(input),
      select: {
        canonicalId: true,
        name: true,
        description: true,
        ownerId: true,
        scopes: true,
        repositoryName: true,
        repositoryUrl: true,
        url: true,
        revision: true,
        sourceCreatedAt: true,
        sourceUpdatedAt: true,
        expiresAt: true,
        catalog: {
          select: {
            ...appCatalogStatusSelect,
            resource: {
              select: {
                id: true,
                key: true,
                name: true,
                enabled: true,
                appDiscoveryEnabled: true,
                version: true,
              },
            },
          },
        },
      },
    }),
    db.discoveredApp.count({ where }),
  ]);
  const owners = await usersById(rows.map((row) => row.ownerId));
  const now = new Date();
  return {
    total,
    items: rows.map((row) => {
      const owner = row.ownerId ? owners.get(row.ownerId) : undefined;
      return {
        id: row.canonicalId,
        name: row.name,
        description: row.description,
        ownerId: row.ownerId,
        ownerName: owner?.name ?? null,
        ownerEmail: owner?.email ?? null,
        scopes: [...row.scopes].sort(),
        repository: repositoryOf(row),
        url: row.url,
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
        catalogState: appCatalogStatus(row.catalog.resource, row.catalog, now).state,
      };
    }),
  };
}
