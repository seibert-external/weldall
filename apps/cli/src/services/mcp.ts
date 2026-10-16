import { createDpopProof } from "@weldall/sdk";
import {
  MCP_LIMITS,
  assertMcpJson,
  mcpConnectorsSchema,
  mcpToolsResponseSchema,
  mcpResourcesResponseSchema,
  mcpCallResultSchema,
  mcpReadResultSchema,
  mcpConnectorKeySchema,
  mcpConnectionSelectionSchema,
  mcpToolCallSchema,
  mcpResourceReadSchema,
  parseMcpResponse,
} from "@weldall/sdk/mcp";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { withAccess } from "./auth.js";

export type McpOperation = "list" | "tools" | "resources" | "call" | "read-resource";
const responseSchemas = {
  list: mcpConnectorsSchema,
  tools: mcpToolsResponseSchema,
  resources: mcpResourcesResponseSchema,
  call: mcpCallResultSchema,
  "read-resource": mcpReadResultSchema,
};

/** Private JSON API only. One DPoP-bound request; never replay tool calls after any failure. */
export async function requestMcp(
  config: WeldallConfig,
  operation: McpOperation,
  input: {
    connectorKey?: string;
    connection?: string;
    name?: string;
    arguments?: unknown;
    uri?: string;
  },
  abort?: AbortSignal,
) {
  let path: string;
  let body: unknown;
  try {
    if (operation === "list") path = "/api/me/mcp/connectors";
    else {
      const key = mcpConnectorKeySchema.parse(input.connectorKey);
      path = `/api/me/mcp/connectors/${encodeURIComponent(key)}/${operation}`;
      body =
        operation === "call"
          ? mcpToolCallSchema.parse({
              connection: input.connection,
              name: input.name,
              arguments: input.arguments ?? {},
            })
          : operation === "read-resource"
            ? mcpResourceReadSchema.parse({ connection: input.connection, uri: input.uri })
            : mcpConnectionSelectionSchema.parse({ connection: input.connection });
      assertMcpJson(body, MCP_LIMITS.requestBytes);
    }
  } catch {
    throw new CliError("Invalid MCP connector, connection, tool, resource URI or JSON arguments");
  }
  const method = operation === "list" ? "GET" : "POST";
  const url = `${config.issuer}${path}`;
  const signal = AbortSignal.any([AbortSignal.timeout(35_000), ...(abort ? [abort] : [])]);
  try {
    return await withAccess(config, async (session) => {
      signal.throwIfAborted();
      const response = await fetch(url, {
        method,
        redirect: "error",
        signal,
        headers: {
          authorization: `DPoP ${session.accessToken}`,
          dpop: await createDpopProof({
            ...session.credentials,
            method,
            url,
            accessToken: session.accessToken,
          }),
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const maximum = response.ok
        ? operation === "call" || operation === "read-resource"
          ? MCP_LIMITS.resultBytes
          : MCP_LIMITS.definitionsBytes
        : 16_384;
      if (Number(response.headers.get("content-length") ?? 0) > maximum) {
        await response.body?.cancel();
        throw new CliError("MCP response exceeds the size limit");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      const cancel = () => {
        void reader?.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const part = await reader?.read();
          if (!part || part.done) break;
          length += part.value.byteLength;
          if (length > maximum) throw new CliError("MCP response exceeds the size limit");
          chunks.push(part.value);
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader?.cancel().catch(() => {});
      }
      if (!response.ok) {
        // Do not print arbitrary server/proxy error bodies or token/proof reflections.
        if (response.status === 404)
          throw new CliError(
            "MCP connector unavailable or this Weldall version does not support MCP",
          );
        throw new CliError(
          `Weldall MCP request failed with HTTP ${response.status}. No tool call was retried.`,
        );
      }
      try {
        return parseMcpResponse(
          responseSchemas[operation],
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          maximum,
        );
      } catch {
        throw new CliError("Weldall returned an invalid MCP response");
      }
    });
  } catch (error) {
    if (signal.aborted)
      throw new CliError(
        "MCP operation cancelled or timed out; execution may already have occurred. Do not retry automatically.",
      );
    if (error instanceof CliError) throw error;
    throw new CliError("MCP request could not complete; it was not retried.");
  }
}
