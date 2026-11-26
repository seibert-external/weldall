import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord } from "../http.js";
import { authenticatedGet } from "./skills.js";

/**
 * Shared agents the signed-in person may use: their own, and those shared with a permission they
 * hold. Served by `GET /api/me/agents`; a server that predates agent discovery answers 404.
 */
export interface AgentSummary {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  own: boolean;
  ownerName: string | null;
  scopes: string[];
  config: { format: string; version: number; definition: unknown };
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  source: { type: string; key: string; name: string };
}
export interface AgentWarning {
  source: string;
  code: string;
}
/** A resource that keeps agents for people: where a client stores and shares them. */
export interface AgentRegistry {
  key: string;
  name: string;
  endpoint: string;
  /** The permission to request for the registry's agents API. */
  scope: string;
  /** Whether the signed-in person holds that permission. */
  allowed: boolean;
}
/** A permission the person holds and can therefore share an agent with. */
export interface ShareableScope {
  key: string;
  description: string;
}
export interface AgentList {
  items: AgentSummary[];
  warnings: AgentWarning[];
  registries: AgentRegistry[];
  shareableScopes: ShareableScope[];
}

const isAgentSummary = (value: unknown): value is AgentSummary =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.sourceId === "string" &&
  typeof value.name === "string" &&
  typeof value.description === "string" &&
  typeof value.own === "boolean" &&
  (value.ownerName === null || typeof value.ownerName === "string") &&
  Array.isArray(value.scopes) &&
  value.scopes.every((scope) => typeof scope === "string") &&
  isRecord(value.config) &&
  typeof value.config.format === "string" &&
  typeof value.config.version === "number" &&
  typeof value.revision === "number" &&
  typeof value.createdAt === "string" &&
  typeof value.updatedAt === "string" &&
  typeof value.expiresAt === "string" &&
  typeof value.expired === "boolean" &&
  isRecord(value.source) &&
  typeof value.source.type === "string" &&
  typeof value.source.key === "string" &&
  typeof value.source.name === "string";

const isAgentRegistry = (value: unknown): value is AgentRegistry =>
  isRecord(value) &&
  typeof value.key === "string" &&
  typeof value.name === "string" &&
  typeof value.endpoint === "string" &&
  typeof value.scope === "string" &&
  typeof value.allowed === "boolean";

const isShareableScope = (value: unknown): value is ShareableScope =>
  isRecord(value) && typeof value.key === "string" && typeof value.description === "string";

export function parseAgentList(value: unknown): AgentList {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isAgentSummary) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(
      (warning) =>
        isRecord(warning) && typeof warning.source === "string" && typeof warning.code === "string",
    ) ||
    !Array.isArray(value.registries) ||
    !value.registries.every(isAgentRegistry) ||
    !Array.isArray(value.shareableScopes) ||
    !value.shareableScopes.every(isShareableScope)
  )
    throw new CliError("Weldall returned an invalid agent list");
  return value as unknown as AgentList;
}

const AGENT_LIST_LABEL = "Weldall agent list request";

export async function listAgents(config: WeldallConfig): Promise<AgentList> {
  try {
    const { value } = await authenticatedGet(
      config,
      `${config.issuer}/api/me/agents`,
      undefined,
      AGENT_LIST_LABEL,
    );
    return parseAgentList(value);
  } catch (error) {
    // The transfer layer carries the status only in the message, so match its exact prefix rather
    // than any "HTTP 404" that a server's error detail might contain.
    const notFound = `${AGENT_LIST_LABEL} failed with HTTP 404`;
    if (
      error instanceof CliError &&
      (error.message === notFound || error.message.startsWith(`${notFound}:`))
    )
      throw new CliError("This Weldall server does not offer shared agents.", {
        cause: error,
        hint: "Agent discovery needs a newer Weldall server.",
      });
    throw error;
  }
}
