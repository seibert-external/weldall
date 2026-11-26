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
  /** Sent by servers since agents carry a creation date; absent from earlier ones. */
  createdAt?: string;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  source: { type: string; key: string; name: string };
}
export interface AgentWarning {
  source: string;
  code: string;
}
export interface AgentList {
  items: AgentSummary[];
  warnings: AgentWarning[];
  /** Where a client keeps and shares agents; passed through as the server sends it. */
  registries?: unknown[];
  /** The permissions the person can share an agent with; passed through likewise. */
  shareableScopes?: unknown[];
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
  (value.createdAt === undefined || typeof value.createdAt === "string") &&
  typeof value.updatedAt === "string" &&
  typeof value.expiresAt === "string" &&
  typeof value.expired === "boolean" &&
  isRecord(value.source) &&
  typeof value.source.type === "string" &&
  typeof value.source.key === "string" &&
  typeof value.source.name === "string";

export function parseAgentList(value: unknown): AgentList {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isAgentSummary) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(
      (warning) =>
        isRecord(warning) && typeof warning.source === "string" && typeof warning.code === "string",
    )
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
