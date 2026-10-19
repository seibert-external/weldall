import { db } from "@weldall/db";
import { z } from "zod";
import {
  MCP_LIMITS,
  assertMcpJson,
  mcpCallResultSchema,
  mcpReadResultSchema,
  mcpResourceReadSchema,
  mcpToolCallSchema,
  mcpConnectionSelectionSchema,
  mcpConnectorKeySchema,
  parseMcpResponse,
} from "@weldall/sdk/mcp";
import { ConnectorError, type AuthorizedConnectorActor } from "../connectors/contracts";
import { canAccessConnector, connectorScopeInclude } from "../connectors/access";
import { authorizeConnectionUse } from "../connectors/core/authorization";
import { fingerprintConnectorRequest } from "../connectors/audit";
import { cachedMcpTools, discoverMcpResources } from "./discovery";
import { mcpToolCache, type McpToolCache, type ToolCacheStatus } from "./tool-cache";
import { logger } from "../observability/logger";
import { resolvePublicIpv4 } from "../connectors/core/secure-fetch";
import { withMcpClient } from "./transport";
import { writeMcpAudit } from "./audit";
import { connectorProviders, getConnectorProvider } from "../connectors/registry";
import { connectorCapabilities } from "../connectors/provider";

export async function listMcpConnectors(actor: AuthorizedConnectorActor) {
  const rows = await db.connector.findMany({
    where: {
      enabled: true,
      providerType: {
        in: connectorProviders
          .filter((provider) => connectorCapabilities(provider).includes("mcp"))
          .map((provider) => provider.type),
      },
    },
    include: connectorScopeInclude,
    orderBy: { key: "asc" },
    take: 1001,
  });
  if (rows.length > 1000)
    throw new ConnectorError("too_large", "MCP connector catalog limit exceeded.", 503);
  return rows
    .filter((row) => canAccessConnector({ connector: row, actor }))
    .map((row) => ({
      key: row.key,
      name: row.name,
      capabilities: connectorCapabilities(getConnectorProvider(row.providerType)),
    }));
}
const active = new Map<string, number>();
let total = 0;
export type McpOperation = "tools" | "resources" | "call" | "read-resource";
export async function executeMcpOperation(
  input: {
    actor: AuthorizedConnectorActor;
    connectorKey: string;
    operation: McpOperation;
    body: unknown;
    signal: AbortSignal;
  },
  toolCache: McpToolCache = mcpToolCache,
) {
  const key = mcpConnectorKeySchema.parse(input.connectorKey);
  assertMcpJson(input.body, MCP_LIMITS.requestBytes);
  const selection = mcpConnectionSelectionSchema.parse({
    connection: (input.body as { connection?: unknown })?.connection,
  });
  const call = input.operation === "call" ? mcpToolCallSchema.parse(input.body) : undefined;
  const read =
    input.operation === "read-resource" ? mcpResourceReadSchema.parse(input.body) : undefined;
  const started = Date.now();
  const phaseStarted = performance.now();
  const timings: {
    authorizationMs?: number;
    initializationMs?: number;
    cacheWaitMs?: number;
    invocationMs?: number;
    discoveryMs?: number;
    cacheStatus?: ToolCacheStatus;
  } = {};
  let outcome = "failed";
  let subjectId = "unknown";
  let ownerId: string | undefined;
  let connectionKey: string | undefined;
  let authorizationSource: "owner" | "scope" | undefined;
  let connectorId: string | undefined;
  const operation = `mcp.${input.operation === "call" ? "tool_call" : input.operation === "read-resource" ? "resource_read" : "discovery"}`;
  const details = () => ({
    connectorKey: key,
    ...(connectorId ? { connectorId } : {}),
    ...(ownerId ? { credentialManagerId: ownerId } : {}),
    ...(connectionKey ? { connectionKey } : {}),
    ...(authorizationSource ? { authorizationSource } : {}),
    ...(call ? { toolName: call.name } : {}),
    ...(read
      ? {
          requestFingerprint: fingerprintConnectorRequest({
            method: "READ",
            requestedUrl: { href: read.uri },
          }),
        }
      : {}),
    durationMs: Date.now() - started,
  });
  try {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(MCP_LIMITS.operationMs)]);
    const output = await authorizeConnectionUse({
      actor: input.actor,
      selector: selection.connection,
      connectorKey: key,
      signal,
      async preflight(row, provider) {
        subjectId = row.id;
        ownerId = row.ownerId;
        connectionKey = row.key ?? undefined;
        authorizationSource = row.accessMode === "SCOPED" ? "scope" : "owner";
        if (total >= 100 || (active.get(row.id) ?? 0) >= 4)
          throw new ConnectorError("rate_limit", "Too many concurrent MCP operations.", 429);
        connectorId = row.connectorId;
        if (!provider.mcp)
          throw new ConnectorError(
            "connector_mcp_unsupported",
            "Connector does not support MCP.",
            400,
          );
        await resolvePublicIpv4(provider.mcp.getEndpoint(row.connector.providerConfig).hostname);
      },
      async run(connection) {
        timings.authorizationMs = performance.now() - phaseStarted;
        if (total >= 100 || (active.get(connection.row.id) ?? 0) >= 4)
          throw new ConnectorError("rate_limit", "Too many concurrent MCP operations.", 429);
        active.set(connection.row.id, (active.get(connection.row.id) ?? 0) + 1);
        total++;
        try {
          if (input.operation === "tools" || call) {
            let tools;
            const cacheStarted = performance.now();
            try {
              tools = await cachedMcpTools(connection, toolCache, (status) => {
                timings.cacheStatus = status;
              });
            } finally {
              timings.cacheWaitMs = performance.now() - cacheStarted;
            }
            if (input.operation === "tools") return tools;
            if (call && !tools.tools.some((tool) => tool.name === call.name))
              throw new ConnectorError("tool_unavailable", "MCP tool is unavailable.", 404);
          }
          return await withMcpClient({
            connection,
            onInitialize: (ms) => {
              timings.initializationMs = ms;
            },
            async run(client) {
              const capabilities = client.getServerCapabilities();
              if (input.operation === "resources") {
                const discoveryStarted = performance.now();
                try {
                  return capabilities?.resources
                    ? await discoverMcpResources(client, signal)
                    : { resources: [] };
                } finally {
                  timings.discoveryMs = performance.now() - discoveryStarted;
                }
              }
              if (call) {
                if (!capabilities?.tools)
                  throw new ConnectorError("tool_unavailable", "MCP tool is unavailable.", 404);
                const invocationStarted = performance.now();
                try {
                  return parseMcpResponse(
                    mcpCallResultSchema,
                    await client.request(
                      {
                        method: "tools/call",
                        params: { name: call.name, arguments: call.arguments },
                      },
                      z.unknown(),
                      { signal, timeout: MCP_LIMITS.operationMs, resetTimeoutOnProgress: false },
                    ),
                  );
                } finally {
                  timings.invocationMs = performance.now() - invocationStarted;
                }
              }
              if (!capabilities?.resources || !read)
                throw new ConnectorError(
                  "resource_unavailable",
                  "MCP resource is unavailable.",
                  404,
                );
              const invocationStarted = performance.now();
              try {
                return parseMcpResponse(
                  mcpReadResultSchema,
                  await client.request(
                    { method: "resources/read", params: { uri: read.uri } },
                    z.unknown(),
                    { signal, timeout: MCP_LIMITS.operationMs, resetTimeoutOnProgress: false },
                  ),
                );
              } finally {
                timings.invocationMs = performance.now() - invocationStarted;
              }
            },
          });
        } finally {
          total--;
          const count = (active.get(connection.row.id) ?? 1) - 1;
          if (count) active.set(connection.row.id, count);
          else active.delete(connection.row.id);
        }
      },
    });
    const businessError = "isError" in output && output.isError === true;
    await writeMcpAudit({
      tx: db,
      actor: input.actor,
      outcome: businessError ? "failed" : "success",
      operation: `${operation}.${businessError ? "failed" : "succeeded"}`,
      subjectId,
      details: details(),
    });
    outcome = businessError ? "failed" : "success";
    return output;
  } catch (error) {
    timings.authorizationMs ??= performance.now() - phaseStarted;
    await writeMcpAudit({
      tx: db,
      actor: input.actor,
      operation: `${operation}.failed`,
      subjectId,
      outcome:
        error instanceof ConnectorError && [403, 404].includes(error.status) ? "denied" : "failed",
      details: details(),
    });
    throw error;
  } finally {
    logger.info(
      {
        event: "mcp.operation",
        requestId: input.actor.requestId,
        connectionId: subjectId,
        operation: input.operation,
        outcome,
        durationMs: Date.now() - started,
        ...timings,
      },
      "MCP operation completed",
    );
  }
}
