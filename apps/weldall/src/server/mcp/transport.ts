import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { MCP_LIMITS, McpBoundaryError, assertMcpJson } from "@weldall/sdk/mcp";
import { createPinnedFetch } from "../connectors/core/secure-fetch";
import { ConnectorError } from "../connectors/errors";
import type { AuthorizedConnectionUse } from "../connectors/core/authorization";

/** A fresh SDK session per upstream use. No SDK authProvider (it can replay POST after 401),
 * SSE reconnection, resumption tokens or pooling. Test fixtures may supply the network adapter.
 */
export async function withMcpClient<T>(input: {
  connection: AuthorizedConnectionUse;
  run(client: Client): Promise<T>;
  fetch?: typeof fetch;
  onInitialize?: (durationMs: number) => void;
}): Promise<T> {
  const { connection } = input;
  const capability = connection.provider.mcp;
  if (!capability)
    throw new ConnectorError("connector_mcp_unsupported", "Connector does not support MCP.");
  const endpoint = capability.getEndpoint(connection.row.connector.providerConfig);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([connection.signal, lifetime.signal]);
  const fetchFn =
    input.fetch ??
    createPinnedFetch({
      signal,
      maximumBytes: MCP_LIMITS.resultBytes,
      validateUrl(url, method) {
        if (url.href !== endpoint.href || !["GET", "POST", "DELETE"].includes(method))
          throw new McpBoundaryError("upstream_protocol_error");
      },
    });
  const client = new Client({ name: "weldall", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1,
      maxReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (url, init = {}) => {
      if (
        String(url) !== endpoint.href ||
        !["GET", "POST", "DELETE"].includes(init.method ?? "GET")
      )
        throw new McpBoundaryError("upstream_protocol_error");
      await connection.assertCurrent();
      capability.validateEndpoint({ endpoint, config: connection.row.connector.providerConfig });
      const headers = new Headers();
      for (const [key, value] of new Headers(init.headers)) {
        if (["accept", "content-type", "mcp-session-id", "mcp-protocol-version"].includes(key)) {
          if (value.length > 8192) throw new McpBoundaryError("upstream_protocol_error");
          headers.set(key, value);
        }
      }
      if (init.body !== undefined && typeof init.body !== "string")
        throw new McpBoundaryError("upstream_protocol_error");
      const requestSignal = AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]);
      const request = capability.buildAuthenticatedRequest({
        endpoint,
        credentials: connection.credentials,
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: init.body as string }),
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      const response = await fetchFn(endpoint, {
        ...request,
        signal: requestSignal,
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new McpBoundaryError("upstream_authentication_failed");
      }
      return response;
    },
  });
  client.onerror = () => {}; // SDK error text may contain upstream bodies; never log it.
  try {
    // SDK 1.32 declares sessionId as string | undefined but Transport uses an exact optional.
    const initializeStarted = performance.now();
    try {
      await client.connect(transport as Parameters<Client["connect"]>[0], {
        timeout: MCP_LIMITS.initializeMs,
        signal,
        resetTimeoutOnProgress: false,
      });
    } finally {
      input.onInitialize?.(performance.now() - initializeStarted);
    }
    assertMcpJson(client.getServerCapabilities(), MCP_LIMITS.definitionsBytes);
    const result = await input.run(client);
    capability.assertSafeResult(result, connection.credentials);
    return result;
  } catch (error) {
    if (error instanceof McpBoundaryError || error instanceof ConnectorError) throw error;
    if (signal.aborted)
      throw new McpBoundaryError(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
      throw new McpBoundaryError("timeout");
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))
      throw new McpBoundaryError("upstream_authentication_failed");
    throw new McpBoundaryError(
      error instanceof McpError ? "upstream_protocol_error" : "upstream_unavailable",
    );
  } finally {
    try {
      await transport.terminateSession();
    } catch {
      /* Cleanup never replays or replaces the operation. */
    } finally {
      lifetime.abort();
      await client.close().catch(() => {});
    }
  }
}
