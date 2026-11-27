import { type Prisma } from "@weldall/db";
import { z } from "zod";
import type { CatalogSide } from "../discovery/catalog-sides";
import {
  GLOBAL_SCOPE,
  INT4_MAX,
  itemFields,
  pagedCatalog,
  storableText,
  text,
} from "../discovery/paged-catalog";

/**
 * Agent discovery: a resource an administrator switched it on for (`agentDiscoveryEnabled`)
 * publishes the agents people shared through it. Its resource metadata names the endpoint
 * (`weldall_agents_endpoint`); Weldall reads it page by page as every paged catalog
 * (`discovery/paged-catalog.ts`) and keeps a copy as one side of the resource's catalog
 * (`discovery/catalog-sides.ts`).
 *
 * Discovery does not read an agent's `config.definition`: it checks only that it is an object and
 * passes it on with `format` and `version`, so a client can refuse what it does not know. (The
 * directory reads one format to show it, see `agentContent` in `service.ts`.)
 */
export const AGENT_CATALOG_METADATA_KEY = "weldall_agents_endpoint" as const;
/**
 * Optional in the same metadata: the API people's clients use to keep and share agents at the
 * resource, `{ endpoint, scope }`. Weldall passes it on (`service.ts`), so a client is not
 * configured with a resource's address.
 */
export const AGENT_API_METADATA_KEY = "weldall_agents_api" as const;
export const AGENT_ASSERTION_TYPE = "weldall-agents+jwt" as const;
export const AGENT_ASSERTION_PURPOSE = "agents:read" as const;

/** Deeper `config.definition` values are refused before they reach the JSON column. */
const MAX_DEFINITION_DEPTH = 64;

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
  id: itemFields.id,
  name: text().min(1).max(200),
  description: text().max(1_000),
  /** Weldall user id of the person who shared the agent. */
  owner: text().min(1).max(200),
  /** Holding any one of these is enough to use the agent. */
  scopes: itemFields.scopes,
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
  revision: itemFields.revision,
  createdAt: itemFields.dateTime,
  updatedAt: itemFields.dateTime,
  expiresAt: itemFields.dateTime,
});
export type PublishedAgent = z.output<typeof publishedAgentSchema>;

export const agentCatalog = pagedCatalog({
  kind: "agents",
  metadataKey: AGENT_CATALOG_METADATA_KEY,
  assertionType: AGENT_ASSERTION_TYPE,
  assertionPurpose: AGENT_ASSERTION_PURPOSE,
  item: publishedAgentSchema,
});

/**
 * One page: throws when the page as a whole is malformed; an agent that fails validation is left
 * out and counted in `skipped`.
 */
export function parseAgentCatalogPage(
  value: unknown,
  expectedResource: string,
): { agents: PublishedAgent[]; skipped: number; nextCursor: string | undefined } {
  const { items, ...page } = agentCatalog.parsePage(value, expectedResource);
  return { agents: items, ...page };
}

/** Keys Weldall does not know are ignored (and not passed on), so a registry can add some. */
const agentApiSchema = z.object({
  endpoint: z.string().max(2_000),
  scope: z.string().max(200).regex(GLOBAL_SCOPE),
});

/**
 * The agent side of a refresh. Besides the agents it takes the agents API from the metadata, when
 * the resource names one; metadata with a malformed one fails the agent side.
 */
export const agentSide: CatalogSide<"agents", PublishedAgent> = {
  kind: "agents",
  catalog: agentCatalog,
  metadata(metadata, endpoint) {
    const value = metadata[AGENT_API_METADATA_KEY];
    const api = value === undefined ? null : agentApiSchema.parse(value);
    return {
      agentApiEndpoint: api ? endpoint(api.endpoint) : null,
      agentApiScope: api?.scope ?? null,
    };
  },
  clearedMetadata: { agentApiEndpoint: null, agentApiScope: null },
  remove: (tx, catalogId) => tx.discoveredAgent.deleteMany({ where: { catalogId } }),
  insert: (tx, catalogId, resourceKey, agents) =>
    tx.discoveredAgent.createMany({
      data: agents.map((agent) => ({
        catalogId,
        localId: agent.id,
        canonicalId: `${resourceKey}.${agent.id}`,
        name: agent.name,
        description: agent.description,
        ownerId: agent.owner,
        scopes: agent.scopes,
        configFormat: agent.config.format,
        configVersion: agent.config.version,
        config: agent.config.definition as Prisma.InputJsonObject,
        revision: agent.revision,
        sourceCreatedAt: agent.createdAt,
        sourceUpdatedAt: agent.updatedAt,
        expiresAt: agent.expiresAt,
      })),
    }),
};
