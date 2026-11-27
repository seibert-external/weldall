import { z } from "zod";
import type { CatalogSide, SideRegistration } from "../discovery/catalog-sides";
import { itemFields, pagedCatalog, text } from "../discovery/paged-catalog";

/**
 * App discovery: a resource an administrator switched it on for (`appDiscoveryEnabled`) publishes
 * the apps it knows of, typically repositories with a marker file in the organization's Git host.
 * Its resource metadata names the endpoint (`weldall_apps_endpoint`); Weldall reads it page by page
 * as every paged catalog (`discovery/paged-catalog.ts`) and keeps a read-only copy as one side of
 * the resource's catalog (`discovery/catalog-sides.ts`). Nothing is written back.
 */
export const APP_CATALOG_METADATA_KEY = "weldall_apps_endpoint" as const;
/**
 * Optional in the same metadata: the API people's clients publish apps through (the "registry"),
 * `{ endpoint, scope, adminScope?, git?, gitCredentials? }`. A client does not decide by itself
 * which resource is a registry: Weldall passes this on (`registries` of `GET /api/me/apps`) only
 * for a resource an administrator switched app discovery on for, and only when it passes
 * `checkAppApi` against the resource's registration.
 */
export const APP_API_METADATA_KEY = "weldall_apps_api" as const;
export const APP_ASSERTION_TYPE = "weldall-apps+jwt" as const;
export const APP_ASSERTION_PURPOSE = "apps:read" as const;

/** No line break or other control character: the value is shown on one line. */
const SINGLE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;
const singleLine = (max: number) => text().min(1).max(max).regex(SINGLE_LINE);

/**
 * An https URL without credentials, stored in the form Weldall parsed. It is rendered as a link, so
 * nothing but https may pass (`httpsHref` checks it again where it is rendered).
 */
const httpsUrl = text()
  .max(2_000)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "not a URL" });
      return z.NEVER;
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      context.addIssue({ code: "custom", message: "not an https URL without credentials" });
      return z.NEVER;
    }
    return url.href;
  });

/**
 * Fields Weldall does not know are ignored and not stored, so a resource can add fields without
 * its apps being left out; the known fields are checked strictly.
 */
const publishedAppSchema = z.object({
  id: itemFields.id,
  name: singleLine(120),
  description: text().min(1).max(1_000),
  /** Weldall user id of the person responsible for the app, when the resource knows one. */
  owner: text().min(1).max(200).nullable(),
  /** Holding any one of these is enough to see the app. */
  scopes: itemFields.scopes,
  /** Null for an app without a Git repository; the key itself is required. */
  repository: z.object({ name: singleLine(200), url: httpsUrl }).nullable(),
  /** Where the app runs; null when it is not deployed (or the resource does not know). */
  url: httpsUrl.nullable(),
  revision: itemFields.revision,
  createdAt: itemFields.dateTime,
  updatedAt: itemFields.dateTime,
  expiresAt: itemFields.dateTime,
});
export type PublishedApp = z.output<typeof publishedAppSchema>;

export const appCatalog = pagedCatalog({
  kind: "apps",
  metadataKey: APP_CATALOG_METADATA_KEY,
  assertionType: APP_ASSERTION_TYPE,
  assertionPurpose: APP_ASSERTION_PURPOSE,
  item: publishedAppSchema,
});

/**
 * One page: throws when the page as a whole is malformed; an app that fails validation is left out
 * and counted in `skipped`.
 */
export function parseAppCatalogPage(
  value: unknown,
  expectedResource: string,
): { apps: PublishedApp[]; skipped: number; nextCursor: string | undefined } {
  const { items, ...page } = appCatalog.parsePage(value, expectedResource);
  return { apps: items, ...page };
}

/** A registry's apps API as Weldall passes it on to clients. */
export interface AppApi {
  /** `https://<resource origin>/.../apps`. */
  endpoint: string;
  /** The scope a client asks for to publish. */
  scope: string;
  /** The scope that administers the registry; null when it names none. */
  adminScope: string | null;
  /** `https://<resource origin>/git/`; null when it offers no Git route. */
  git: string | null;
  /** Where a Git credential helper gets credentials; null when it names none. */
  gitCredentials: string | null;
}

/** Why Weldall did not accept a resource's `weldall_apps_api`; shown to administrators. */
export type AppApiRefusal =
  /** Not an object, or a field of the wrong type or length. */
  | "malformed"
  /** Not an https URL on the resource's origin without query or fragment ending in `/apps`. */
  | "endpoint_invalid"
  | "scope_not_of_resource"
  /** One of Weldall's own permissions: never a registry's. */
  | "scope_reserved"
  | "admin_scope_not_of_resource"
  | "admin_scope_reserved"
  | "admin_scope_same_as_scope"
  /** Not exactly `<resource origin>/git/`. */
  | "git_invalid"
  /** Not an https URL on the resource's origin without query or fragment. */
  | "git_credentials_invalid";

/**
 * Its shape only. Keys Weldall does not know are ignored, so a registry can add some; `null` is
 * taken as a missing optional value.
 */
const appApiShape = z.object({
  endpoint: z.string().max(2_000),
  scope: z.string().min(1).max(200),
  adminScope: z.string().min(1).max(200).nullish(),
  git: z.string().max(2_000).nullish(),
  gitCredentials: z.string().max(2_000).nullish(),
});

/** An https URL on `origin` without credentials, query or fragment, in the form given. */
function onOrigin(value: string, origin: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" &&
    url.origin === origin &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !url.href.includes("?") &&
    !url.href.includes("#")
    ? url
    : null;
}

/**
 * Checks a resource's `weldall_apps_api` (as it is in the metadata, or as Weldall stored it) against
 * the resource's registration: `null` when it names none, otherwise the API to pass on or why it is
 * refused. The registration, not the resource, decides: every URL is on the resource's own origin,
 * and every scope is one of the resource's own and none of Weldall's.
 */
export function checkAppApi(
  value: unknown,
  registration: SideRegistration,
): { api: AppApi } | { refusal: AppApiRefusal } | null {
  if (value === undefined || value === null) return null;
  const parsed = appApiShape.safeParse(value);
  if (!parsed.success) return { refusal: "malformed" };
  const { origin } = new URL(registration.resourceIdentifier);
  const endpoint = onOrigin(parsed.data.endpoint, origin);
  if (!endpoint || !endpoint.pathname.endsWith("/apps")) return { refusal: "endpoint_invalid" };
  const own = (key: string) => registration.scopes.find((scope) => scope.key === key);
  const scope = own(parsed.data.scope);
  if (!scope) return { refusal: "scope_not_of_resource" };
  if (scope.isSystem) return { refusal: "scope_reserved" };
  const adminScopeKey = parsed.data.adminScope ?? null;
  if (adminScopeKey !== null) {
    const adminScope = own(adminScopeKey);
    if (!adminScope) return { refusal: "admin_scope_not_of_resource" };
    if (adminScope.isSystem) return { refusal: "admin_scope_reserved" };
    if (adminScope.key === scope.key) return { refusal: "admin_scope_same_as_scope" };
  }
  const git = parsed.data.git ?? null;
  if (git !== null && git !== `${origin}/git/`) return { refusal: "git_invalid" };
  const gitCredentials = parsed.data.gitCredentials ?? null;
  const credentials = gitCredentials === null ? null : onOrigin(gitCredentials, origin);
  if (gitCredentials !== null && !credentials) return { refusal: "git_credentials_invalid" };
  return {
    api: {
      endpoint: endpoint.href,
      scope: scope.key,
      adminScope: adminScopeKey,
      git,
      gitCredentials: credentials?.href ?? null,
    },
  };
}

/** The catalog columns that store a registry's apps API (`DiscoveredSkillCatalog.appApi*`). */
const clearedAppApi = {
  appApiEndpoint: null,
  appApiScope: null,
  appApiAdminScope: null,
  appApiGit: null,
  appApiGitCredentials: null,
  appApiRefusal: null,
  appApiCheckedAt: null,
} as const;

/** The stored apps API as `checkAppApi` reads it again. */
export const storedAppApi = (catalog: {
  appApiEndpoint: string | null;
  appApiScope: string | null;
  appApiAdminScope: string | null;
  appApiGit: string | null;
  appApiGitCredentials: string | null;
}): Record<string, string> | null =>
  catalog.appApiEndpoint === null || catalog.appApiScope === null
    ? null
    : {
        endpoint: catalog.appApiEndpoint,
        scope: catalog.appApiScope,
        ...(catalog.appApiAdminScope === null ? {} : { adminScope: catalog.appApiAdminScope }),
        ...(catalog.appApiGit === null ? {} : { git: catalog.appApiGit }),
        ...(catalog.appApiGitCredentials === null
          ? {}
          : { gitCredentials: catalog.appApiGitCredentials }),
      };

/**
 * The app side of a refresh. Besides its endpoint it takes the apps API from the metadata
 * (`settings`): checked and stored on its own, so an apps API that is refused or missing never
 * fails the apps, and apps that cannot be read do not drop the apps API.
 */
export const appSide: CatalogSide<"apps", PublishedApp> = {
  kind: "apps",
  catalog: appCatalog,
  settings(metadata, registration, now) {
    const checked = checkAppApi(metadata[APP_API_METADATA_KEY], registration);
    return {
      ...clearedAppApi,
      ...(checked && "api" in checked
        ? {
            appApiEndpoint: checked.api.endpoint,
            appApiScope: checked.api.scope,
            appApiAdminScope: checked.api.adminScope,
            appApiGit: checked.api.git,
            appApiGitCredentials: checked.api.gitCredentials,
          }
        : checked
          ? { appApiRefusal: checked.refusal }
          : {}),
      appApiCheckedAt: now,
    };
  },
  clearedMetadata: clearedAppApi,
  remove: (tx, catalogId) => tx.discoveredApp.deleteMany({ where: { catalogId } }),
  insert: (tx, catalogId, resourceKey, apps) =>
    tx.discoveredApp.createMany({
      data: apps.map((app) => ({
        catalogId,
        localId: app.id,
        canonicalId: `${resourceKey}.${app.id}`,
        name: app.name,
        description: app.description,
        ownerId: app.owner,
        scopes: app.scopes,
        repositoryName: app.repository?.name ?? null,
        repositoryUrl: app.repository?.url ?? null,
        url: app.url,
        revision: app.revision,
        sourceCreatedAt: app.createdAt,
        sourceUpdatedAt: app.updatedAt,
        expiresAt: app.expiresAt,
      })),
    }),
};
