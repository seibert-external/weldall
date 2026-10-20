import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ResourceRegistryEntry } from "@weldall/sdk";
import {
  MCP_LIMITS,
  assertMcpJson,
  mcpCallResultSchema,
  mcpReadResultSchema,
  mcpToolNameSchema,
  mcpUriSchema,
  validateNativeMcpMetadata,
  nativeMcpToolsSchema,
  nativeMcpResourcesSchema,
  parseMcpResponse,
  type NativeMcpMetadata,
} from "@weldall/sdk/mcp";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord } from "../http.js";
import { nativeMcpCatalogCache } from "../storage/native-mcp-cache.js";
import {
  listScopesWithSubject,
  prepareResourceClient,
  type PreparedResourceClient,
} from "./resources.js";

export type NativeMcpSource = {
  resource: ResourceRegistryEntry;
  metadata: NativeMcpMetadata;
  subject: string;
};

async function boundedText(
  response: Response,
  signal: AbortSignal,
  maximum: number,
): Promise<string> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (Number(response.headers.get("content-length") ?? 0) > maximum)
      throw new CliError("Native MCP response exceeds the size limit");
    for (;;) {
      signal.throwIfAborted();
      const next = await reader?.read();
      if (!next || next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new CliError("Native MCP response exceeds the size limit");
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader?.cancel().catch(() => {});
  }
}

/** Resolve URLs only from the authenticated registry, never from a tool argument or URI. */
export async function resolveNativeMcp(
  config: WeldallConfig,
  resourceKey: string,
  signal: AbortSignal,
  snapshot?: Awaited<ReturnType<typeof listScopesWithSubject>>,
): Promise<NativeMcpSource> {
  signal.throwIfAborted();
  const { result, subject } = snapshot ?? (await listScopesWithSubject(config, signal));
  signal.throwIfAborted();
  const matches = result.resources.filter((entry) => entry.key === resourceKey);
  if (matches.length !== 1) throw new CliError("Native MCP resource unavailable");
  const resource = matches[0]!;
  const response = await fetch(
    `${resource.authorizationServer}/.well-known/oauth-protected-resource`,
    {
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new CliError("Native MCP metadata unavailable");
  }
  const metadataDocument: unknown = JSON.parse(await boundedText(response, signal, 64 * 1024));
  if (
    !isRecord(metadataDocument) ||
    metadataDocument.resource !== resource.resourceIdentifier ||
    !Array.isArray(metadataDocument.authorization_servers) ||
    !metadataDocument.authorization_servers.includes(resource.authorizationServer)
  )
    throw new CliError("Native MCP metadata does not match the registered resource");
  let metadata: NativeMcpMetadata;
  try {
    metadata = validateNativeMcpMetadata(resource, metadataDocument);
  } catch {
    throw new CliError(
      "Resource does not advertise compatible native MCP metadata within the trusted registration",
    );
  }
  if (metadata.discoveryScopes.some((scope) => !resource.grantedScopes.includes(scope)))
    throw new CliError("Native MCP discovery permission is missing");
  return { resource, metadata, subject };
}

async function withNativeClient<T>(
  source: NativeMcpSource,
  prepared: PreparedResourceClient,
  signal: AbortSignal,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  if (
    prepared.resource.key !== source.resource.key ||
    prepared.resource.resourceIdentifier !== source.resource.resourceIdentifier ||
    prepared.resource.authorizationServer !== source.resource.authorizationServer
  )
    throw new CliError("Resource registration changed. Discover it again.");
  // Bun 1.3.14 otherwise evaluates MCP's schemas before shared Zod initialization.
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  signal.throwIfAborted();
  const endpoint = source.metadata.endpoint;
  const client = new Client({ name: "weldall", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1,
      maxReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (url, init = {}) => {
      signal.throwIfAborted();
      if (
        String(url) !== endpoint ||
        !["POST", "GET", "DELETE"].includes(init.method ?? "GET") ||
        (init.body !== undefined && typeof init.body !== "string")
      )
        throw new CliError("Invalid native MCP transport request");
      const headers = new Headers();
      for (const [key, value] of new Headers(init.headers))
        if (["accept", "content-type", "mcp-protocol-version"].includes(key))
          headers.set(key, value);
      headers.set("weldall-mcp-revision", source.metadata.revision);
      const response = await prepared.request({
        url: endpoint,
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers),
        ...(typeof init.body === "string" ? { body: init.body } : {}),
        signal,
      });
      if (
        response.headers.get("mcp-session-id") ||
        response.headers.get("weldall-mcp-revision") !== source.metadata.revision
      ) {
        await response.body?.cancel();
        throw new CliError(
          "Native MCP transport or revision changed; the operation was not retried",
        );
      }
      if (response.status === 202 || response.status === 204) return response;
      if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
        await response.body?.cancel();
        throw new CliError("Native MCP requires the stateless JSON transport");
      }
      return new Response(await boundedText(response, signal, MCP_LIMITS.resultBytes), {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  client.onerror = () => {};
  try {
    await client.connect(transport as Parameters<Client["connect"]>[0], {
      signal,
      timeout: MCP_LIMITS.initializeMs,
    });
    signal.throwIfAborted();
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const catalogCacheKey = (config: WeldallConfig, source: NativeMcpSource) =>
  JSON.stringify([
    config.issuer,
    source.subject,
    source.resource.key,
    source.resource.resourceIdentifier,
    source.resource.authorizationServer,
    source.resource.downstreamClientId,
    [...source.resource.requestPrefixes].sort(),
    [...source.resource.supportedScopes].sort(),
    [...source.resource.grantedScopes].sort(),
    source.metadata,
  ]);

function parseNativeCatalog(source: NativeMcpSource, value: unknown) {
  const tools = parseMcpResponse(nativeMcpToolsSchema, value, MCP_LIMITS.definitionsBytes).tools;
  const resources = parseMcpResponse(
    nativeMcpResourcesSchema,
    value,
    MCP_LIMITS.definitionsBytes,
  ).resources;
  if (
    new Set(tools.map((t) => t.name)).size !== tools.length ||
    new Set(resources.map((r) => r.uri)).size !== resources.length ||
    [...tools, ...resources].some((entry) =>
      entry._meta["weldall/scopes"].some(
        (scope) => !source.resource.supportedScopes.includes(scope),
      ),
    )
  )
    throw new CliError("Invalid native MCP operation policies or duplicate definitions");
  const catalog = { tools, resources };
  assertMcpJson(catalog, MCP_LIMITS.definitionsBytes);
  return catalog;
}

export async function loadNativeMcpCatalog(
  config: WeldallConfig,
  source: NativeMcpSource,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const key = catalogCacheKey(config, source);
  const cached = await nativeMcpCatalogCache.read(key);
  signal.throwIfAborted();
  if (cached !== null) {
    try {
      return parseNativeCatalog(source, cached);
    } catch {
      await nativeMcpCatalogCache.remove(key);
    }
  }
  const prepared = await prepareResourceClient(
    config,
    source.metadata.endpoint,
    source.metadata.discoveryScopes,
    {
      signal,
      expectedSubject: source.subject,
      expectedResource: source.resource,
    },
  );
  const catalog = await withNativeClient(source, prepared, signal, async (client) => {
    const toolList = await client.listTools({}, { signal, timeout: MCP_LIMITS.discoveryMs });
    const resourceList = await client.listResources(
      {},
      { signal, timeout: MCP_LIMITS.discoveryMs },
    );
    // This native profile always publishes one complete bounded catalog.
    if (toolList.nextCursor || resourceList.nextCursor)
      throw new CliError("Native MCP catalog is incomplete");
    return parseNativeCatalog(source, { tools: toolList.tools, resources: resourceList.resources });
  });
  signal.throwIfAborted();
  await nativeMcpCatalogCache.write(key, catalog);
  return catalog;
}

export async function requestNativeMcp(
  config: WeldallConfig,
  operation: "tools" | "resources" | "call" | "read-resource",
  input: {
    resourceKey: string;
    name?: string;
    arguments?: unknown;
    uri?: string;
    expectedSubject?: string;
    expectedIssuer?: string;
    expectedRevision?: string;
    expectedResourceIdentifier?: string;
  },
  abort?: AbortSignal,
) {
  const signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(abort ? [abort] : [])]);
  let cacheKey: string | undefined;
  try {
    if (input.expectedIssuer !== undefined && input.expectedIssuer !== config.issuer)
      throw new CliError("Weldall origin changed. Discover the resource again.");
    const source = await resolveNativeMcp(config, input.resourceKey, signal);
    cacheKey = catalogCacheKey(config, source);
    if (
      (input.expectedSubject !== undefined && input.expectedSubject !== source.subject) ||
      (input.expectedRevision !== undefined &&
        input.expectedRevision !== source.metadata.revision) ||
      (input.expectedResourceIdentifier !== undefined &&
        input.expectedResourceIdentifier !== source.resource.resourceIdentifier)
    )
      throw new CliError("Native MCP identity or catalog changed. Discover the resource again.");
    const catalog = await loadNativeMcpCatalog(config, source, signal);
    if (operation === "tools") return { tools: catalog.tools };
    if (operation === "resources") return { resources: catalog.resources };
    const definition =
      operation === "call"
        ? catalog.tools.find((entry) => entry.name === mcpToolNameSchema.parse(input.name))
        : catalog.resources.find((entry) => entry.uri === mcpUriSchema.parse(input.uri));
    if (!definition) throw new CliError("Native MCP operation is not in the current catalog");
    const scopes = [
      ...new Set([...source.metadata.discoveryScopes, ...definition._meta["weldall/scopes"]]),
    ].sort();
    const prepared = await prepareResourceClient(config, source.metadata.endpoint, scopes, {
      signal,
      expectedSubject: source.subject,
      expectedResource: source.resource,
    });
    const args = input.arguments ?? {};
    if (operation === "call" && !isRecord(args))
      throw new CliError("Tool arguments must be a JSON object");
    assertMcpJson(args, MCP_LIMITS.requestBytes);
    return await withNativeClient(source, prepared, signal, async (client) =>
      operation === "call"
        ? parseMcpResponse(
            mcpCallResultSchema,
            await client.callTool(
              { name: input.name!, arguments: args as Record<string, unknown> },
              undefined,
              { signal, timeout: MCP_LIMITS.operationMs },
            ),
          )
        : parseMcpResponse(
            mcpReadResultSchema,
            await client.readResource(
              { uri: input.uri! },
              { signal, timeout: MCP_LIMITS.operationMs },
            ),
          ),
    );
  } catch {
    if (cacheKey !== undefined) await nativeMcpCatalogCache.remove(cacheKey);
    throw new CliError(
      "Native MCP request failed or was denied. No operation was retried; a submitted write may already have completed.",
    );
  }
}
