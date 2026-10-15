import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MCP_LIMITS,
  mcpResourcesPageSchema,
  mcpToolsPageSchema,
  parseMcpResponse,
} from "@weldall/sdk/mcp";
import { McpBoundaryError } from "@weldall/sdk/mcp";

/** Requires an already authorized, initialized client with a size-bounded HTTP transport. */
async function collect<T>(input: {
  client: Client;
  method: "tools/list" | "resources/list";
  parse: (value: unknown, budget: number) => { items: T[]; nextCursor: string | undefined };
  identity: (item: T) => string;
  maximum: number;
  signal: AbortSignal | undefined;
}) {
  const deadline = AbortSignal.timeout(MCP_LIMITS.discoveryMs);
  const signal = AbortSignal.any([deadline, ...(input.signal ? [input.signal] : [])]);
  const items: T[] = [];
  const identities = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let budget = MCP_LIMITS.definitionsBytes;
  try {
    for (let pageNumber = 0; pageNumber < MCP_LIMITS.pages; pageNumber++) {
      signal.throwIfAborted();
      // Use request rather than listTools: the latter compiles arbitrary upstream output
      // schemas before our complexity/size checks. Discovery must not execute schemas.
      const raw = await input.client.request(
        { method: input.method, params: cursor ? { cursor } : {} },
        z.unknown(),
        { signal, timeout: MCP_LIMITS.discoveryMs, resetTimeoutOnProgress: false },
      );
      const page = input.parse(raw, budget);
      budget -= Buffer.byteLength(JSON.stringify(raw), "utf8");
      if (items.length + page.items.length > input.maximum)
        throw new McpBoundaryError("response_too_large");
      for (const item of page.items) {
        const identity = input.identity(item);
        if (identities.has(identity)) throw new McpBoundaryError("upstream_protocol_error");
        identities.add(identity);
        items.push(item);
      }
      cursor = page.nextCursor;
      if (cursor === undefined) return items;
      if (cursors.has(cursor)) throw new McpBoundaryError("upstream_protocol_error");
      cursors.add(cursor);
    }
    throw new McpBoundaryError("response_too_large");
  } catch (error) {
    if (error instanceof McpBoundaryError) throw error;
    if (input.signal?.aborted) throw new McpBoundaryError("cancelled");
    if (deadline.aborted || (error instanceof McpError && error.code === ErrorCode.RequestTimeout))
      throw new McpBoundaryError("timeout");
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))
      throw new McpBoundaryError("upstream_authentication_failed");
    // SDK diagnostics can contain raw upstream error bodies; never retain them as a cause.
    throw new McpBoundaryError(
      error instanceof McpError ? "upstream_protocol_error" : "upstream_unavailable",
    );
  }
}

export async function discoverMcpTools(client: Client, signal?: AbortSignal) {
  return {
    tools: await collect({
      client,
      method: "tools/list",
      parse: (value, budget) => {
        const page = parseMcpResponse(mcpToolsPageSchema, value, budget);
        return { items: page.tools, nextCursor: page.nextCursor };
      },
      identity: (tool) => tool.name,
      maximum: MCP_LIMITS.tools,
      signal,
    }),
  };
}

export async function discoverMcpResources(client: Client, signal?: AbortSignal) {
  return {
    resources: await collect({
      client,
      method: "resources/list",
      parse: (value, budget) => {
        const page = parseMcpResponse(mcpResourcesPageSchema, value, budget);
        return { items: page.resources, nextCursor: page.nextCursor };
      },
      identity: (resource) => resource.uri,
      maximum: MCP_LIMITS.resources,
      signal,
    }),
  };
}
