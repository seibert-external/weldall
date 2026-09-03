import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "./types.js";

/** A single page from the content collection, as stored in the index. */
export interface SearchDocument {
  /** Page route on the site, e.g. `/team/overview/`. */
  path: string;
  /** Page title from the frontmatter. */
  title: string;
  /** Page description from the frontmatter (may be empty). */
  description: string;
  /** Plain-text page body (markdown stripped). */
  content: string;
}

/** The result of indexing a content directory. */
export interface BuiltIndex {
  /** The parsed documents that were inserted. */
  documents: SearchDocument[];
  /** The serialized Orama index. */
  raw: unknown;
}

/** The on-disk shape of `.weldall-search/index.json`. */
export interface IndexFile {
  /** The Orama language used to build the index. */
  language: string;
  /** The serialized Orama index. */
  raw: unknown;
}

/**
 * The minimal Orama surface this module uses. Kept local and untyped so the
 * published package does not leak `@orama/*` type dependencies (optional peer
 * dependencies, loaded lazily at runtime).
 */
interface OramaModule {
  create(config: unknown): Promise<unknown>;
  insertMultiple(db: unknown, docs: readonly SearchDocument[]): Promise<void>;
  save(db: unknown): Promise<unknown>;
  load(db: unknown, raw: unknown): Promise<void>;
  search(
    db: unknown,
    options: { term: string; limit: number; mode: "fulltext" },
  ): Promise<{ hits: Array<{ document: SearchDocument; score?: number }> }>;
}

let oramaPromise: Promise<OramaModule> | undefined;

/**
 * Lazily loads Orama. `@orama/orama` is an optional peer dependency, so the
 * core SDK never loads it; only the Starlight search path does.
 */
function loadOrama(): Promise<OramaModule> {
  oramaPromise ??= import("@orama/orama").then(
    (module) => module as unknown as OramaModule,
    () => {
      throw new Error(
        "@weldall/sdk/starlight requires @orama/orama (optional peer dependency). " +
          "Run: pnpm add @orama/orama @orama/stemmers @orama/stopwords",
      );
    },
  );
  return oramaPromise;
}

interface MatterFile {
  data: Record<string, unknown>;
  content: string;
}

let matterPromise: Promise<(input: string) => MatterFile> | undefined;

/**
 * Lazily loads gray-matter (optional peer dependency) for frontmatter parsing.
 */
function loadMatter(): Promise<(input: string) => MatterFile> {
  matterPromise ??= import("gray-matter").then(
    (module) => {
      const fn = (module as { default?: unknown }).default ?? module;
      return fn as (input: string) => MatterFile;
    },
    () => {
      throw new Error(
        "@weldall/sdk/starlight requires gray-matter (optional peer dependency). " +
          "Run: pnpm add gray-matter",
      );
    },
  );
  return matterPromise;
}

/**
 * Converts markdown to plain searchable text: strips code blocks, inline code,
 * images, link URLs (keeping the label), HTML, and common markdown markers.
 *
 * @param markdown - Raw markdown body.
 * @returns Whitespace-collapsed plain text.
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`]*`/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gmu, " ")
    .replace(/[*_~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Recursively collects `.md`/`.mdx` files below a directory, sorted by path.
 * A missing directory yields an empty list.
 *
 * @param dir - Directory to scan.
 * @returns Absolute file paths.
 */
async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (/\.(md|mdx)$/u.test(entry.name)) files.push(full);
  }
  return files.sort();
}

/**
 * Maps a content-relative path to the Starlight route convention:
 * `team/overview.md` -> `/team/overview/`, `index.md` -> `/`.
 *
 * @param relative - Path relative to the content directory.
 * @returns The page route.
 */
export function routeFor(relative: string): string {
  const slug = relative.replace(/\.(md|mdx)$/u, "").replaceAll("\\", "/");
  const normalized = slug === "index" ? "" : slug.replace(/\/index$/u, "");
  return `/${normalized}/`.replace(/\/{2,}/gu, "/");
}

/**
 * Builds an Orama index from a Starlight content directory. Each MDX/MD file is
 * parsed for frontmatter (`title`, `description`) and its body is stripped to
 * plain text. A missing or empty directory yields an empty index.
 *
 * @param contentDir - Directory containing `**\/*.{md,mdx}` files.
 * @param language - Orama language (stemming/stopwords), e.g. `"german"`.
 * @returns The parsed documents and the serialized index.
 */
export async function buildIndexFromDir(
  contentDir: string,
  language = "german",
): Promise<BuiltIndex> {
  const orama = await loadOrama();
  const matter = await loadMatter();
  const files = await collectFiles(contentDir);
  const documents: SearchDocument[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const { data, content } = matter(raw);
    const relative = path.relative(contentDir, file);
    const title =
      (typeof data.title === "string" && data.title.trim()) ||
      path.basename(file).replace(/\.(md|mdx)$/u, "");
    const description = (typeof data.description === "string" && data.description.trim()) || "";
    documents.push({
      path: routeFor(relative),
      title,
      description,
      content: stripMarkdown(content),
    });
  }

  const db = await orama.create({ schema: SCHEMA, language });
  if (documents.length > 0) await orama.insertMultiple(db, documents);
  const raw = await orama.save(db);
  return { documents, raw };
}

/**
 * Serializes an index to disk as JSON (`.weldall-search/index.json`),
 * creating parent directories as needed.
 *
 * @param indexFile - Destination file path.
 * @param index - The index to write.
 */
export async function writeIndexFile(indexFile: string, index: IndexFile): Promise<void> {
  await mkdir(path.dirname(indexFile), { recursive: true });
  await writeFile(indexFile, JSON.stringify(index), "utf8");
}

/**
 * Loads a serialized index back into a searchable Orama instance.
 *
 * @param indexFile - Path to the serialized index.
 * @returns A ready-to-search Orama database.
 */
export async function readIndexFile(indexFile: string): Promise<unknown> {
  const orama = await loadOrama();
  const index = JSON.parse(await readFile(indexFile, "utf8")) as IndexFile;
  const db = await orama.create({ schema: SCHEMA, language: index.language ?? "german" });
  await orama.load(db, index.raw);
  return db;
}

/** The Orama schema: every field is a searchable plain string. */
export const SCHEMA = {
  path: "string",
  title: "string",
  description: "string",
  content: "string",
} as const;

/**
 * Cuts a long body to a bounded excerpt at a word boundary.
 */
const excerpt = (content: string, length = 260): string => {
  if (content.length <= length) return content;
  const cut = content.slice(0, length);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
};

/**
 * Runs a full-text search against a loaded index and shapes the hits into the
 * endpoint's response format (path, title, description, excerpt, score).
 *
 * @param db - A loaded Orama index.
 * @param term - The query term.
 * @param limit - Maximum number of results.
 * @returns Ranked search hits.
 */
export async function runSearch(db: unknown, term: string, limit: number): Promise<SearchHit[]> {
  const orama = await loadOrama();
  const result = await orama.search(db, { term, limit, mode: "fulltext" });
  return result.hits.map((hit) => {
    const doc = hit.document as SearchDocument;
    return {
      path: doc.path,
      title: doc.title,
      description: doc.description,
      excerpt: excerpt(doc.content),
      score: typeof hit.score === "number" ? hit.score : 0,
    };
  });
}
