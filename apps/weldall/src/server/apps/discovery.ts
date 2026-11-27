import { z } from "zod";
import type { CatalogSide } from "../discovery/catalog-sides";
import { itemFields, pagedCatalog, text } from "../discovery/paged-catalog";

/**
 * App discovery: a resource an administrator switched it on for (`appDiscoveryEnabled`) publishes
 * the apps it knows of, typically repositories with a marker file in the organization's Git host.
 * Its resource metadata names the endpoint (`weldall_apps_endpoint`); Weldall reads it page by page
 * as every paged catalog (`discovery/paged-catalog.ts`) and keeps a read-only copy as one side of
 * the resource's catalog (`discovery/catalog-sides.ts`). Nothing is written back.
 */
export const APP_CATALOG_METADATA_KEY = "weldall_apps_endpoint" as const;
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

/** The app side of a refresh; it takes nothing from the metadata besides its endpoint. */
export const appSide: CatalogSide<"apps", PublishedApp> = {
  kind: "apps",
  catalog: appCatalog,
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
