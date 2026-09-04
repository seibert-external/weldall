import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadLanguageAnalysis, type SearchLanguage } from "./languages.js";
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

/**
 * A page record persisted for the content endpoint: the searchable document
 * plus its original markdown body for full-page reads.
 */
export interface PageRecord extends SearchDocument {
  /** Original markdown page body (frontmatter removed). */
  markdown: string;
}

/** The result of indexing a content directory. */
export interface BuiltIndex {
  /** The parsed documents that were inserted. */
  documents: PageRecord[];
  /** The serialized Orama index. */
  raw: unknown;
}

/** The on-disk shape of `.weldall-search/index.json`. */
export interface IndexFile {
  /** The language used to build the index. */
  language: SearchLanguage;
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

type TokenizerConfig = {
  language: string;
  stemming?: boolean;
  stemmer?: (word: string) => string;
  stopWords?: string[];
};

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

async function tokenizerFor(language: SearchLanguage): Promise<TokenizerConfig> {
  const analysis = await loadLanguageAnalysis(language);
  return {
    language: analysis.language,
    stemming: true,
    stemmer: analysis.stemmer,
    stopWords: analysis.stopWords,
  };
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
 * @param language - Search language used for stemming and stop-word removal.
 * @returns The parsed documents and the serialized index.
 */
export async function buildIndexFromDir(
  contentDir: string,
  language: SearchLanguage = "english",
): Promise<BuiltIndex> {
  const orama = await loadOrama();
  const matter = await loadMatter();
  const files = await collectFiles(contentDir);
  const documents: PageRecord[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const { data, content } = matter(raw);
    const relative = path.relative(contentDir, file);
    const title =
      (typeof data.title === "string" && data.title.trim()) ||
      path.basename(file).replace(/\.(md|mdx)$/u, "");
    const description = (typeof data.description === "string" && data.description.trim()) || "";
    const body = content.trim();
    documents.push({
      path: routeFor(relative),
      title,
      description,
      content: stripMarkdown(body),
      markdown: body,
    });
  }

  const db = await orama.create({
    schema: SCHEMA,
    components: { tokenizer: await tokenizerFor(language) },
  });
  if (documents.length > 0) {
    // Only the schema fields go into the Orama index; the raw markdown body is
    // persisted separately for the content endpoint.
    const searchable = documents.map(({ path, title, description, content }) => ({
      path,
      title,
      description,
      content,
    }));
    await orama.insertMultiple(db, searchable);
  }
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
 * Serializes a full-page document list to disk as JSON
 * (`.weldall-search/documents.json`), creating parent directories as needed.
 *
 * @param documentsFile - Destination file path.
 * @param documents - The page records to write.
 */
export async function writeDocumentsFile(
  documentsFile: string,
  documents: readonly PageRecord[],
): Promise<void> {
  await mkdir(path.dirname(documentsFile), { recursive: true });
  await writeFile(documentsFile, JSON.stringify(documents), "utf8");
}

/**
 * Loads the persisted full-page document list.
 *
 * @param documentsFile - Path to the serialized documents.
 * @returns The page records.
 */
export async function readDocumentsFile(documentsFile: string): Promise<PageRecord[]> {
  return JSON.parse(await readFile(documentsFile, "utf8")) as PageRecord[];
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
  const db = await orama.create({
    schema: SCHEMA,
    components: { tokenizer: await tokenizerFor(index.language ?? "english") },
  });
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
 * Finds the most useful literal query match for an excerpt. Prefer the full
 * query, then its longest individual terms so multi-word searches still show
 * why a result matched.
 */
const queryMatch = (
  content: string,
  term: string,
): { index: number; length: number } | undefined => {
  const lowerContent = content.toLocaleLowerCase();
  const candidates = [
    term.trim(),
    ...(term.match(/[\p{L}\p{N}]+/gu) ?? []).sort((left, right) => right.length - left.length),
  ];
  for (const candidate of new Set(candidates.map((value) => value.toLocaleLowerCase()))) {
    if (!candidate) continue;
    const index = lowerContent.indexOf(candidate);
    if (index >= 0) return { index, length: candidate.length };
  }
  return undefined;
};

/**
 * Cuts a long body to a bounded, word-aligned excerpt centered on the query.
 * Falls back to the beginning when stemming found a result without a literal
 * occurrence of the submitted query or one of its terms.
 */
const excerpt = (content: string, term: string, length = 260): string => {
  if (content.length <= length) return content;
  const match = queryMatch(content, term);
  if (!match) {
    const cut = content.slice(0, length);
    const lastSpace = cut.lastIndexOf(" ");
    return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
  }

  let start = Math.max(0, match.index - Math.floor((length - match.length) / 2));
  let end = Math.min(content.length, start + length);
  if (end - start < length) start = Math.max(0, end - length);

  if (start > 0) {
    const nextSpace = content.indexOf(" ", start);
    if (nextSpace >= 0 && nextSpace < match.index) start = nextSpace + 1;
  }
  if (end < content.length) {
    const lastSpace = content.lastIndexOf(" ", end);
    if (lastSpace > match.index + match.length) end = lastSpace;
  }

  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
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
      excerpt: excerpt(doc.content, term),
      score: typeof hit.score === "number" ? hit.score : 0,
    };
  });
}
