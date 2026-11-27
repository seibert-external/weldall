import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WELDALL_ISSUER } from "../oauth/constants";
import { signWeldallJwt } from "../oauth/jwt";

/**
 * A paged catalog a resource publishes next to its skill catalog: shared agents
 * (`agents/discovery.ts`) and apps (`apps/discovery.ts`). Both are read the same way, so only what
 * they publish differs: each kind names the metadata key of its endpoint, the type and purpose of
 * the assertion Weldall signs for it, and the schema of one item.
 *
 * The resource's metadata names the endpoint. Weldall reads it with a short-lived signed assertion,
 * one per page (`?cursor=<nextCursor>`), because such items are made by people and have no natural
 * upper bound. The envelope of a page is checked strictly, each item on its own: an item that fails
 * validation is left out and counted (`skipped`), so one broken item does not hold back the others;
 * a page that is broken as a whole fails this kind's side of the refresh, and so does a catalog in
 * which every item failed validation (`<kind>_all_invalid`).
 */
export type PagedCatalogKind = "agents" | "apps";

export const PAGED_CATALOG_SCHEMA_VERSION = 1 as const;

const PAGE_LIMIT_BYTES = 2_097_152;
const MAX_PAGE_ITEMS = 500;
const MAX_PAGES = 100;
const MAX_ITEMS = 5_000;
/**
 * A catalog above these bounds fails the refresh as a whole, so a resource has to stay below them
 * by its own limits.
 */
const MAX_TOTAL_BYTES = 67_108_864;

export type PagedCatalogFailureCategory<K extends PagedCatalogKind> =
  /** Discovery of this kind is on, but the resource metadata names no (usable) endpoint for it. */
  | `${K}_metadata_invalid`
  | `${K}_unavailable`
  | `${K}_unauthorized`
  /** A request answered with a page that is malformed as a whole, or the catalog broke a bound. */
  | `${K}_invalid`
  /**
   * The resource published items, and every one failed validation. That points at a mismatch
   * between the resource and Weldall rather than at broken items, so the last copy stays.
   */
  | `${K}_all_invalid`;

export class PagedCatalogError<K extends PagedCatalogKind> extends Error {
  constructor(readonly category: PagedCatalogFailureCategory<K>) {
    super(category);
  }
}

/** A permission as a resource names it: `<namespace>:<name>`. */
export const GLOBAL_SCOPE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;
/** The largest value of an `INTEGER` column. */
export const INT4_MAX = 2_147_483_647;

/**
 * Text PostgreSQL can store: no NUL character (refused in `TEXT` and in `JSONB`) and no lone
 * surrogate (not valid UTF-8; with the `u` flag `\p{Cs}` matches only unpaired ones). An item with
 * such a value is left out like any invalid item, rather than failing the write of the whole catalog.
 */
const UNSTORABLE_TEXT = /\u0000|\p{Cs}/u;
export const storableText = (value: string): boolean => !UNSTORABLE_TEXT.test(value);
export const text = () => z.string().refine(storableText, "contains text that cannot be stored");

/** The fields every kind of item carries, checked the same way. */
export const itemFields = {
  /** Unique within the resource; Weldall's id is `<resource key>.<id>`. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** Holding any one of these is enough to see the item. */
  scopes: z
    .array(z.string().max(200).regex(GLOBAL_SCOPE))
    .max(100)
    .refine((scopes) => new Set(scopes).size === scopes.length),
  revision: z.number().int().min(1).max(INT4_MAX),
  dateTime: z.iso.datetime().transform((value) => new Date(value)),
};

export interface PagedCatalog<K extends PagedCatalogKind, Item> {
  kind: K;
  /** The key of the endpoint in the resource's protected resource metadata. */
  metadataKey: string;
  assertionType: string;
  assertionPurpose: string;
  /**
   * One page: throws when the page as a whole is malformed; an item that fails validation is left
   * out and counted in `skipped`.
   */
  parsePage(
    value: unknown,
    expectedResource: string,
  ): { items: Item[]; skipped: number; nextCursor: string | undefined };
  /**
   * Reads every page. A failure of a request or of a page as a whole discards all pages (it throws
   * a `PagedCatalogError`); items that fail validation are only counted, unless none passed.
   */
  fetch(input: {
    resourceIdentifier: string;
    endpoint: string;
    fetcher: typeof fetch;
    now: Date;
    /** Reads a JSON body of at most `limit` bytes (shared with the skill catalog refresh). */
    readJson: (response: Response, limit: number) => Promise<unknown>;
    /**
     * The deadline of all pages together. The refresh shares one deadline between every side
     * (`skills/catalogs.ts`), so the time the sides take cannot grow with their number.
     */
    signal: AbortSignal;
  }): Promise<{ items: Item[]; skipped: number }>;
}

export function pagedCatalog<K extends PagedCatalogKind, Item extends { id: string }>(spec: {
  kind: K;
  metadataKey: string;
  assertionType: string;
  assertionPurpose: string;
  /**
   * One item. Fields Weldall does not know should be ignored and not stored (no strict object), so
   * a resource can add fields without its items being left out.
   */
  item: z.ZodType<Item>;
}): PagedCatalog<K, Item> {
  const { kind, item } = spec;
  const pageSchema = z.strictObject({
    schemaVersion: z.literal(PAGED_CATALOG_SCHEMA_VERSION),
    resource: z.string(),
    [kind]: z.array(z.unknown()).max(MAX_PAGE_ITEMS),
    nextCursor: z.string().min(1).max(200).optional(),
  });
  const fail = (category: PagedCatalogFailureCategory<K>) => new PagedCatalogError<K>(category);

  const parsePage: PagedCatalog<K, Item>["parsePage"] = (value, expectedResource) => {
    const page = pageSchema.parse(value) as {
      resource: string;
      nextCursor?: string;
    } & Record<K, unknown[]>;
    if (page.resource !== expectedResource)
      throw new TypeError(`${kind} catalog resource mismatch`);
    const items: Item[] = [];
    let skipped = 0;
    for (const candidate of page[kind]) {
      const parsed = item.safeParse(candidate);
      if (parsed.success) items.push(parsed.data);
      else skipped += 1;
    }
    return { items, skipped, nextCursor: page.nextCursor };
  };

  return {
    kind,
    metadataKey: spec.metadataKey,
    assertionType: spec.assertionType,
    assertionPurpose: spec.assertionPurpose,
    parsePage,
    async fetch({ resourceIdentifier, endpoint, fetcher, now, readJson, signal }) {
      const issuedAt = Math.floor(now.getTime() / 1_000);
      const items = new Map<string, Item>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let bytes = 0;
      let skipped = 0;
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        // One assertion per page: the resource accepts each only once.
        const assertion = await signWeldallJwt(
          {
            iss: WELDALL_ISSUER,
            sub: WELDALL_ISSUER,
            aud: endpoint,
            resource: resourceIdentifier,
            purpose: spec.assertionPurpose,
            iat: issuedAt,
            exp: issuedAt + 60,
            jti: randomUUID(),
          },
          spec.assertionType,
        );
        const url = new URL(endpoint);
        if (cursor !== undefined) url.searchParams.set("cursor", cursor);
        let response: Response;
        try {
          response = await fetcher(url.toString(), {
            redirect: "error",
            signal,
            headers: { accept: "application/json", authorization: `Bearer ${assertion}` },
          });
        } catch {
          throw fail(`${kind}_unavailable`);
        }
        if (response.status === 401 || response.status === 403) throw fail(`${kind}_unauthorized`);
        if (!response.ok) throw fail(`${kind}_unavailable`);
        let page: ReturnType<typeof parsePage>;
        try {
          const body = await readJson(response, PAGE_LIMIT_BYTES);
          bytes += JSON.stringify(body).length;
          page = parsePage(body, resourceIdentifier);
        } catch {
          throw fail(`${kind}_invalid`);
        }
        skipped += page.skipped;
        for (const entry of page.items) {
          if (items.has(entry.id)) throw fail(`${kind}_invalid`);
          items.set(entry.id, entry);
        }
        if (items.size > MAX_ITEMS || bytes > MAX_TOTAL_BYTES) throw fail(`${kind}_invalid`);
        if (page.nextCursor === undefined) {
          if (items.size === 0 && skipped > 0) throw fail(`${kind}_all_invalid`);
          return { items: [...items.values()], skipped };
        }
        // A cursor that repeats would loop until the page limit.
        if (cursors.has(page.nextCursor)) throw fail(`${kind}_invalid`);
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw fail(`${kind}_invalid`);
    },
  };
}
