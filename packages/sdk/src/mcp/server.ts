import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WeldallAuthError } from "../errors.js";
import type { AuthContext } from "../types.js";
import {
  MCP_LIMITS,
  assertMcpJson,
  mcpCallResultSchema,
  mcpReadResultSchema,
  mcpResourceSchema,
  mcpToolSchema,
  parseMcpResponse,
} from "./contracts.js";
import { nativeMcpScopesSchema, type NativeMcpProvider } from "./native.js";

export type NativeMcpContext = { auth: AuthContext; signal: AbortSignal };
export type NativeMcpTool = z.input<typeof mcpToolSchema> & {
  scopes: readonly string[];
  handler(
    args: Record<string, unknown>,
    context: NativeMcpContext,
  ): Promise<z.input<typeof mcpCallResultSchema>>;
};
export type NativeMcpResource = z.input<typeof mcpResourceSchema> & {
  scopes: readonly string[];
  handler(context: NativeMcpContext): Promise<z.input<typeof mcpReadResultSchema>>;
};

/** A complete, immutable catalog. Each HTTP request gets its own stateless protocol instance. */
export function createNativeMcp(options: {
  path: string;
  description: string;
  discoveryScopes: readonly string[];
  tools: readonly NativeMcpTool[];
  resources?: readonly NativeMcpResource[];
}): NativeMcpProvider {
  const path = z
    .string()
    .regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/)
    .parse(options.path);
  const description = z.string().min(1).max(2000).parse(options.description);
  const discoveryScopes = nativeMcpScopesSchema.parse(options.discoveryScopes).sort();
  // MCP defaults to Draft 2020-12; format is an annotation, as in the Python SDK.
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  const tools = options.tools.map(({ scopes, handler, ...definition }) => {
    assertMcpJson(definition, MCP_LIMITS.definitionsBytes);
    const parsed = mcpToolSchema.parse(structuredClone(definition));
    if (parsed.inputSchema.$async || parsed.outputSchema?.$async)
      throw new TypeError("Native MCP schemas must be synchronous");
    const validate = validator.compile(parsed.inputSchema);
    const validateOutput = parsed.outputSchema ? validator.compile(parsed.outputSchema) : undefined;
    return {
      definition: {
        ...parsed,
        _meta: { "weldall/scopes": nativeMcpScopesSchema.parse(scopes).sort() },
      },
      validate,
      validateOutput,
      handler,
    };
  });
  const resources = (options.resources ?? []).map(({ scopes, handler, ...definition }) => {
    assertMcpJson(definition, MCP_LIMITS.definitionsBytes);
    return {
      definition: {
        ...mcpResourceSchema.parse(structuredClone(definition)),
        _meta: { "weldall/scopes": nativeMcpScopesSchema.parse(scopes).sort() },
      },
      handler,
    };
  });
  if (
    tools.length > MCP_LIMITS.tools ||
    resources.length > MCP_LIMITS.resources ||
    new Set(tools.map((tool) => tool.definition.name)).size !== tools.length ||
    new Set(resources.map((resource) => resource.definition.uri)).size !== resources.length ||
    [...tools, ...resources].some((entry) => typeof entry.handler !== "function")
  )
    throw new TypeError(
      "Native MCP catalog exceeds limits or has duplicate entries/invalid handlers",
    );
  const catalog = {
    tools: tools.map((tool) => tool.definition),
    resources: resources.map((resource) => resource.definition),
  };
  assertMcpJson(catalog, MCP_LIMITS.definitionsBytes);
  const revision = createHash("sha256")
    .update(JSON.stringify({ path, description, discoveryScopes, catalog }))
    .digest("hex");
  const operationScopes = [
    ...new Set(
      [...tools, ...resources].flatMap((entry) => entry.definition._meta["weldall/scopes"]),
    ),
  ].sort();

  const requireScopes = (auth: AuthContext, scopes: readonly string[]) => {
    if (scopes.some((scope) => !auth.scopes.includes(scope)))
      throw new McpError(-32003, "Required operation scope is missing");
  };
  return Object.freeze({
    path,
    discoveryScopes: Object.freeze(discoveryScopes),
    operationScopes: Object.freeze(operationScopes),
    metadata: (publicOrigin: string) => ({
      schemaVersion: 1 as const,
      transport: "streamable-http-stateless" as const,
      endpoint: new URL(path, publicOrigin).href,
      description,
      discoveryScopes: [...discoveryScopes],
      capabilities: ["tools", "resources"] as ["tools", "resources"],
      revision,
    }),
    async handle(request: Request, auth: AuthContext): Promise<Response> {
      // Never open a standalone SSE stream or create durable sessions.
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      requireScopes(auth, discoveryScopes);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(MCP_LIMITS.operationMs)]);
      const server = new Server(
        { name: "weldall-native", version: "1.0.0" },
        {
          capabilities: { tools: {}, resources: {} },
        },
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        maxRequestBodySize: MCP_LIMITS.requestBytes,
      });
      const invoke = async <T>(run: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        try {
          return await run();
        } catch (error) {
          if (error instanceof McpError) throw error;
          if (error instanceof WeldallAuthError)
            throw new McpError(-32003, "Operation not permitted");
          // Neither provider errors nor input/output validation diagnostics may leak secrets.
          throw new McpError(
            ErrorCode.InternalError,
            "Operation failed; do not retry automatically",
          );
        }
      };
      const noCursor = (params: { cursor?: string | undefined } | undefined) => {
        if (params?.cursor !== undefined)
          throw new McpError(ErrorCode.InvalidParams, "Unknown cursor");
      };
      server.setRequestHandler(ListToolsRequestSchema, (rpc) => {
        noCursor(rpc.params);
        return { tools: catalog.tools };
      });
      server.setRequestHandler(ListResourcesRequestSchema, (rpc) => {
        noCursor(rpc.params);
        return { resources: catalog.resources };
      });
      server.setRequestHandler(ListResourceTemplatesRequestSchema, (rpc) => {
        noCursor(rpc.params);
        return { resourceTemplates: [] };
      });
      server.setRequestHandler(CallToolRequestSchema, (rpc) =>
        invoke(async () => {
          const tool = tools.find((entry) => entry.definition.name === rpc.params.name);
          if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
          requireScopes(auth, tool.definition._meta["weldall/scopes"]);
          const args = rpc.params.arguments ?? {};
          assertMcpJson(args, MCP_LIMITS.requestBytes);
          if (!tool.validate(args))
            throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
          const result = parseMcpResponse(
            mcpCallResultSchema,
            await tool.handler(args, { auth, signal }),
          );
          if (
            tool.validateOutput &&
            !result.isError &&
            !tool.validateOutput(result.structuredContent)
          )
            throw new McpError(
              ErrorCode.InternalError,
              "Invalid tool result; do not retry automatically",
            );
          return result;
        }),
      );
      server.setRequestHandler(ReadResourceRequestSchema, (rpc) =>
        invoke(async () => {
          const resource = resources.find((entry) => entry.definition.uri === rpc.params.uri);
          if (!resource) throw new McpError(ErrorCode.InvalidParams, "Unknown resource");
          requireScopes(auth, resource.definition._meta["weldall/scopes"]);
          return parseMcpResponse(mcpReadResultSchema, await resource.handler({ auth, signal }));
        }),
      );
      server.onerror = () => {};
      let rejectCancelled!: (reason: unknown) => void;
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancelled = reject;
      });
      const abort = () => {
        rejectCancelled(signal.reason);
        void server.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await Promise.race([
          cancelled,
          (async () => {
            signal.throwIfAborted();
            await server.connect(transport);
            signal.throwIfAborted();
            return transport.handleRequest(request);
          })(),
        ]);
        response.headers.set("cache-control", "private, no-store");
        return response;
      } finally {
        signal.removeEventListener("abort", abort);
        await server.close().catch(() => {});
      }
    },
  });
}
