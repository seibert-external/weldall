import { z } from "zod";
import type { DpopKeyPair } from "../types.js";
import { createDpopProof, normalizeHtu } from "../dpop.js";
import {
  MCP_LIMITS,
  assertMcpJson,
  parseMcpResponse,
  mcpConnectorKeySchema,
  mcpConnectorsSchema,
  mcpConnectionsSchema,
  mcpConnectionSelectionSchema,
  mcpToolCallSchema,
  mcpResourceReadSchema,
  mcpToolsResponseSchema,
  mcpResourcesResponseSchema,
  mcpCallResultSchema,
  mcpReadResultSchema,
} from "./contracts.js";

export class WeldallMcpError extends Error {
  constructor(
    readonly code:
      "invalid_request" | "invalid_response" | "request_failed" | "timeout" | "cancelled",
    readonly status?: number,
  ) {
    super(`Weldall MCP ${code}. No request was retried; execution may already have occurred.`);
    this.name = "WeldallMcpError";
  }
}
type Selection = { connectorKey: string; connection: string; signal?: AbortSignal };
export function createWeldallMcpClient(input: {
  issuer: string;
  accessToken: string;
  key: DpopKeyPair;
  fetch?: typeof globalThis.fetch;
}) {
  const origin = new URL(normalizeHtu(input.issuer));
  if (
    origin.pathname !== "/" ||
    new URL(input.issuer).search ||
    new URL(input.issuer).hash ||
    !input.accessToken
  )
    throw new WeldallMcpError("invalid_request");
  async function request<S extends z.ZodType>(
    path: string,
    schema: S,
    body?: unknown,
    abort?: AbortSignal,
    operation = false,
  ): Promise<z.output<S>> {
    const timeout = AbortSignal.timeout(
      operation ? MCP_LIMITS.operationMs : MCP_LIMITS.discoveryMs,
    );
    const signal = AbortSignal.any([timeout, ...(abort ? [abort] : [])]);
    const url = `${origin.origin}${path}`;
    const method = body === undefined ? "GET" : "POST";
    try {
      signal.throwIfAborted();
      const response = await (input.fetch ?? globalThis.fetch)(url, {
        method,
        signal,
        redirect: "error",
        headers: {
          authorization: `DPoP ${input.accessToken}`,
          dpop: await createDpopProof({
            ...input.key,
            method,
            url,
            accessToken: input.accessToken,
          }),
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new WeldallMcpError("request_failed", response.status);
      }
      const maximum = operation ? MCP_LIMITS.resultBytes : MCP_LIMITS.definitionsBytes;
      if (Number(response.headers.get("content-length") ?? 0) > maximum) {
        await response.body?.cancel();
        throw new WeldallMcpError("invalid_response");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => {
        void reader?.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const part = await reader?.read();
          if (!part || part.done) break;
          size += part.value.length;
          if (size > maximum) throw new WeldallMcpError("invalid_response");
          chunks.push(part.value);
        }
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader?.cancel().catch(() => {});
      }
      try {
        return parseMcpResponse(
          schema,
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          maximum,
        );
      } catch {
        throw new WeldallMcpError("invalid_response");
      }
    } catch (error) {
      if (abort?.aborted) throw new WeldallMcpError("cancelled");
      if (timeout.aborted) throw new WeldallMcpError("timeout");
      if (error instanceof WeldallMcpError) throw error;
      throw new WeldallMcpError("request_failed");
    }
  }
  function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    try {
      assertMcpJson(value, MCP_LIMITS.requestBytes);
      return schema.parse(value);
    } catch {
      throw new WeldallMcpError("invalid_request");
    }
  }
  function invoke<S extends z.ZodType>(
    operation: string,
    selection: Selection,
    body: unknown,
    schema: S,
  ) {
    const key = parse(mcpConnectorKeySchema, selection.connectorKey);
    return request(
      `/api/me/mcp/connectors/${encodeURIComponent(key)}/${operation}`,
      schema,
      body,
      selection.signal,
      operation === "call" || operation === "read-resource",
    );
  }
  return {
    listConnectors: (options: { signal?: AbortSignal } = {}) =>
      request("/api/me/mcp/connectors", mcpConnectorsSchema, undefined, options.signal),
    listConnections: (options: { connectorKey?: string; signal?: AbortSignal } = {}) => {
      const query =
        options.connectorKey === undefined
          ? ""
          : `?connectorKey=${encodeURIComponent(parse(mcpConnectorKeySchema, options.connectorKey))}`;
      return request(
        `/api/me/mcp/connections${query}`,
        mcpConnectionsSchema,
        undefined,
        options.signal,
      );
    },
    listTools: (options: Selection) =>
      invoke(
        "tools",
        options,
        parse(mcpConnectionSelectionSchema, { connection: options.connection }),
        mcpToolsResponseSchema,
      ),
    listResources: (options: Selection) =>
      invoke(
        "resources",
        options,
        parse(mcpConnectionSelectionSchema, { connection: options.connection }),
        mcpResourcesResponseSchema,
      ),
    callTool: (options: Selection & { name: string; arguments: Record<string, unknown> }) =>
      invoke(
        "call",
        options,
        parse(mcpToolCallSchema, {
          connection: options.connection,
          name: options.name,
          arguments: options.arguments,
        }),
        mcpCallResultSchema,
      ),
    readResource: (options: Selection & { uri: string }) =>
      invoke(
        "read-resource",
        options,
        parse(mcpResourceReadSchema, { connection: options.connection, uri: options.uri }),
        mcpReadResultSchema,
      ),
  };
}
