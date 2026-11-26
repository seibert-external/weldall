import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WELDALL_ISSUER } from "../oauth/constants";
import { signWeldallJwt } from "../oauth/jwt";

/**
 * Agent discovery: a resource an administrator switched it on for (`agentDiscoveryEnabled`)
 * publishes the agents people shared through it. Its resource metadata names the endpoint (`weldall_agents_endpoint`), Weldall reads it
 * with a short-lived signed assertion, as it reads the skill catalog, and keeps a copy. Unlike the
 * skill catalog the answer is paged (`?cursor=<nextCursor>`), because agents are made by people
 * and have no natural upper bound.
 *
 * Discovery does not read an agent's `config.definition`: it checks only that it is an object and
 * passes it on with `format` and `version`, so a client can refuse what it does not know. (The
 * directory reads one format to show it, see `agentContent` in `service.ts`.)
 *
 * An agent that fails validation is left out and counted (`skipped`), so one broken agent does not
 * hold back the others; a page that is broken as a whole fails the agent side of the refresh, and
 * so does a catalog in which every agent failed validation (`agents_all_invalid`).
 */
export const AGENT_CATALOG_SCHEMA_VERSION = 1 as const;
export const AGENT_CATALOG_METADATA_KEY = "weldall_agents_endpoint" as const;
/**
 * Optional in the same metadata: the API people's clients use to keep and share agents at the
 * resource, `{ endpoint, scope }`. Weldall passes it on (`service.ts`), so a client is not
 * configured with a resource's address.
 */
export const AGENT_API_METADATA_KEY = "weldall_agents_api" as const;
export const AGENT_ASSERTION_TYPE = "weldall-agents+jwt" as const;
export const AGENT_ASSERTION_PURPOSE = "agents:read" as const;

const PAGE_LIMIT_BYTES = 2_097_152;
const MAX_PAGES = 100;
const MAX_AGENTS = 5_000;
/**
 * A catalog above these bounds fails the refresh as a whole, so a resource has to stay below them
 * by its own limits.
 */
const MAX_TOTAL_BYTES = 67_108_864;
/** All pages together; with the metadata and skill catalog requests it stays below the lease. */
const TOTAL_TIMEOUT_MS = 15_000;

export type AgentCatalogFailureCategory =
  /** Agent discovery is on, but the resource metadata names no (usable) agent endpoint or API. */
  | "agents_metadata_invalid"
  | "agents_unavailable"
  | "agents_unauthorized"
  /** A request answered with a page that is malformed as a whole, or the catalog broke a bound. */
  | "agents_invalid"
  /**
   * The resource published agents, and every one failed validation. That points at a mismatch
   * between the resource and Weldall rather than at broken agents, so the last copy stays.
   */
  | "agents_all_invalid";

export class AgentCatalogError extends Error {
  constructor(readonly category: AgentCatalogFailureCategory) {
    super(category);
  }
}

const GLOBAL_SCOPE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;
const dateTime = z.iso.datetime().transform((value) => new Date(value));
/** The largest value of an `INTEGER` column (`revision`, `configVersion`). */
const INT4_MAX = 2_147_483_647;
/** Deeper `config.definition` values are refused before they reach the JSON column. */
const MAX_DEFINITION_DEPTH = 64;

/**
 * Text PostgreSQL can store: no NUL character (refused in `TEXT` and in `JSONB`) and no lone
 * surrogate (not valid UTF-8; with the `u` flag `\p{Cs}` matches only unpaired ones). An agent with such a value is left out like any invalid agent,
 * rather than failing the write of the whole catalog.
 */
const UNSTORABLE_TEXT = /\u0000|\p{Cs}/u;
const storableText = (value: string): boolean => !UNSTORABLE_TEXT.test(value);
const text = () => z.string().refine(storableText, "contains text that cannot be stored");

/** Every key and string in a JSON value is storable text, and it is at most `depth` levels deep. */
function storableJson(value: unknown, depth: number): boolean {
  if (typeof value === "string") return storableText(value);
  if (value === null || typeof value !== "object") return true;
  if (depth === 0) return false;
  if (Array.isArray(value)) return value.every((item) => storableJson(item, depth - 1));
  return Object.entries(value).every(
    ([entryKey, entry]) => storableText(entryKey) && storableJson(entry, depth - 1),
  );
}

/**
 * Fields Weldall does not know are ignored and not stored, so a resource can add fields without
 * its agents being left out; the known fields are checked strictly.
 */
const publishedAgentSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: text().min(1).max(200),
  description: text().max(1_000),
  /** Weldall user id of the person who shared the agent. */
  owner: text().min(1).max(200),
  /** Holding any one of these is enough to use the agent. */
  scopes: z
    .array(z.string().max(200).regex(GLOBAL_SCOPE))
    .max(100)
    .refine((scopes) => new Set(scopes).size === scopes.length),
  config: z.object({
    format: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    version: z.number().int().min(1).max(INT4_MAX),
    /** Passed on as it is; only checked to be an object PostgreSQL can store. */
    definition: z
      .record(z.string(), z.unknown())
      .refine(
        (definition) => storableJson(definition, MAX_DEFINITION_DEPTH),
        "contains a value that cannot be stored",
      ),
  }),
  revision: z.number().int().min(1).max(INT4_MAX),
  createdAt: dateTime,
  updatedAt: dateTime,
  expiresAt: dateTime,
});
export type PublishedAgent = z.output<typeof publishedAgentSchema>;

/** The envelope is checked strictly; each agent in it on its own (`parseAgentCatalogPage`). */
const agentCatalogPageSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_CATALOG_SCHEMA_VERSION),
  resource: z.string(),
  agents: z.array(z.unknown()).max(500),
  nextCursor: z.string().min(1).max(200).optional(),
});

const agentApiSchema = z.strictObject({
  endpoint: z.string().max(2_000),
  scope: z.string().max(200).regex(GLOBAL_SCOPE),
});
/** The agents API a resource names in its metadata; throws when it is malformed. */
export const parseAgentApi = (value: unknown) => agentApiSchema.parse(value);

/**
 * One page: throws when the page as a whole is malformed; an agent that fails validation is left
 * out and counted in `skipped`.
 */
export function parseAgentCatalogPage(
  value: unknown,
  expectedResource: string,
): { agents: PublishedAgent[]; skipped: number; nextCursor: string | undefined } {
  const page = agentCatalogPageSchema.parse(value);
  if (page.resource !== expectedResource) throw new TypeError("agent catalog resource mismatch");
  const agents: PublishedAgent[] = [];
  let skipped = 0;
  for (const candidate of page.agents) {
    const parsed = publishedAgentSchema.safeParse(candidate);
    if (parsed.success) agents.push(parsed.data);
    else skipped += 1;
  }
  return { agents, skipped, nextCursor: page.nextCursor };
}

/**
 * Reads every page of a resource's agent catalog. A failure of a request or of a page as a whole
 * discards all pages; agents that fail validation are only counted, unless none passed.
 */
export async function fetchAgentCatalog(input: {
  resourceIdentifier: string;
  endpoint: string;
  fetcher: typeof fetch;
  now: Date;
  /** Reads a JSON body of at most `limit` bytes (shared with the skill catalog refresh). */
  readJson: (response: Response, limit: number) => Promise<unknown>;
}): Promise<{ agents: PublishedAgent[]; skipped: number }> {
  const { resourceIdentifier, endpoint, fetcher, readJson } = input;
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const issuedAt = Math.floor(input.now.getTime() / 1_000);
  const agents = new Map<string, PublishedAgent>();
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
        purpose: AGENT_ASSERTION_PURPOSE,
        iat: issuedAt,
        exp: issuedAt + 60,
        jti: randomUUID(),
      },
      AGENT_ASSERTION_TYPE,
    );
    const url = new URL(endpoint);
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        redirect: "error",
        signal: deadline,
        headers: { accept: "application/json", authorization: `Bearer ${assertion}` },
      });
    } catch {
      throw new AgentCatalogError("agents_unavailable");
    }
    if (response.status === 401 || response.status === 403)
      throw new AgentCatalogError("agents_unauthorized");
    if (!response.ok) throw new AgentCatalogError("agents_unavailable");
    let page: ReturnType<typeof parseAgentCatalogPage>;
    try {
      const body = await readJson(response, PAGE_LIMIT_BYTES);
      bytes += JSON.stringify(body).length;
      page = parseAgentCatalogPage(body, resourceIdentifier);
    } catch {
      throw new AgentCatalogError("agents_invalid");
    }
    skipped += page.skipped;
    for (const agent of page.agents) {
      if (agents.has(agent.id)) throw new AgentCatalogError("agents_invalid");
      agents.set(agent.id, agent);
    }
    if (agents.size > MAX_AGENTS || bytes > MAX_TOTAL_BYTES)
      throw new AgentCatalogError("agents_invalid");
    if (page.nextCursor === undefined) {
      if (agents.size === 0 && skipped > 0) throw new AgentCatalogError("agents_all_invalid");
      return { agents: [...agents.values()], skipped };
    }
    // A cursor that repeats would loop until the page limit.
    if (cursors.has(page.nextCursor)) throw new AgentCatalogError("agents_invalid");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new AgentCatalogError("agents_invalid");
}
