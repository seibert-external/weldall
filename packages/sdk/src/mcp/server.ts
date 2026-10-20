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
import { MCP_LIMITS, assertMcpJson, mcpCallResultSchema, parseMcpResponse } from "./contracts.js";
import {
  nativeMcpScopesSchema,
  nativeMcpResourceDefinitionSchema,
  nativeMcpToolDefinitionSchema,
  nativeMcpReadResultSchema,
  type NativeMcpProvider,
} from "./native.js";
import { MCP_APP_MIME_TYPE } from "./apps.js";
export { createMcpAppResource, renderMcpAppBootstrapHtml, escapeMcpAppText } from "./display.js";

/** Verified request context shared by native tools and resource reads. */
export type NativeMcpContext = {
  /** Verified user/machine identity and granted scopes. Enforce business/record-level access yourself. */
  auth: AuthContext;
  /** Aborts on request cancellation or the operation deadline. Pass to downstream I/O; cannot undo writes. */
  signal: AbortSignal;
};

/**
 * Descriptive MCP hints for clients/models, NOT permissions or enforcement.
 * Defaults below are MCP interpretation defaults; Weldall does not insert missing values.
 */
export interface NativeMcpToolAnnotations {
  /** Optional human-readable tool label. */
  title?: string | undefined;
  /** `true`: only reads, without modifying its environment. MCP default: `false`. Not access control. */
  readOnlyHint?: boolean | undefined;
  /**
   * `true`: may delete/overwrite existing data; `false`: updates are only additive.
   * Relevant only when `readOnlyHint` is false. MCP default: `true`.
   */
  destructiveHint?: boolean | undefined;
  /**
   * `true`: repeating the same arguments has no additional side effects (not necessarily the same result).
   * Relevant only when `readOnlyHint` is false. MCP default: `false`; does not enable automatic retries.
   */
  idempotentHint?: boolean | undefined;
  /**
   * `true`: may interact with an open-ended set of external entities, e.g. a web search or sending email.
   * `false`: operates within a closed, defined domain, e.g. an internal expense database or memory store.
   * This is independent of read/write behavior: web search can be both read-only and open-world.
   * MCP default: `true`. Does NOT grant network access, scopes or UI bridge permissions.
   */
  openWorldHint?: boolean | undefined;
}

/** A tool definition plus its required scopes and authenticated implementation. */
export interface NativeMcpTool extends z.input<typeof nativeMcpToolDefinitionSchema> {
  /** Unique protocol name within this catalog, e.g. `list_expenses`; not the display title. */
  name: string;
  /** Optional human-readable label shown by clients. */
  title?: string | undefined;
  /** Explain what the tool does and when a model should use it; do not include secrets. */
  description?: string | undefined;
  /** JSON Schema Draft 2020-12 with root `type: "object"`; validated before the handler runs. */
  inputSchema: z.input<typeof nativeMcpToolDefinitionSchema>["inputSchema"];
  /** Optional object schema for successful `structuredContent`, not the text blocks in `content`. */
  outputSchema?: z.input<typeof nativeMcpToolDefinitionSchema>["outputSchema"];
  /** Descriptive behavior hints only. Required scopes, not these hints, enforce authorization. */
  annotations?: NativeMcpToolAnnotations | undefined;
  /**
   * Link a native MCP App view with `{ ui: { resourceUri: view.uri } }`.
   * The referenced HTML resource must also be in `resources`; this does not permit UI tool calls.
   */
  _meta?: z.input<typeof nativeMcpToolDefinitionSchema>["_meta"];
  /** Nonempty list of scopes ALL required for invocation, in addition to discovery scopes. */
  scopes: readonly string[];
  /**
   * Execute after authentication, scope checks and input validation; enforce record-level access here.
   * @param args Validated JSON arguments matching `inputSchema`.
   * @param context Verified caller and cancellation signal; never trust an identity supplied in args.
   * @returns MCP content blocks, optional structured data and optional `isError` for tool-level failures.
   */
  handler(
    args: Record<string, unknown>,
    context: NativeMcpContext,
  ): Promise<z.input<typeof mcpCallResultSchema>>;
}

/** A fixed-URI resource read through the authenticated MCP endpoint, not a public HTTP URL. */
export interface NativeMcpResource extends z.input<typeof nativeMcpResourceDefinitionSchema> {
  /** Stable, unique URI within this catalog; use `createMcpAppResource` to generate a UI URI. */
  uri: string;
  /** Human-readable resource name for discovery. */
  name: string;
  /** Optional display title; may differ from the resource name. */
  title?: string | undefined;
  /** Explain what data reading this resource returns; do not include secrets. */
  description?: string | undefined;
  /** Content MIME type, e.g. `application/json` or `text/html;profile=mcp-app` for UI resources. */
  mimeType?: string | undefined;
  /** Nonempty list of scopes ALL required for each read, in addition to discovery scopes. */
  scopes: readonly string[];
  /**
   * Read current data for the verified caller; enforce record-level access and honor cancellation.
   * @param context Identity and signal for this read; no preceding tool arguments/results are supplied.
   * @returns MCP resource contents containing text or base64-encoded blobs and their URIs.
   */
  handler(context: NativeMcpContext): Promise<z.input<typeof nativeMcpReadResultSchema>>;
}

/**
 * Create a complete, immutable native MCP catalog with scope-checked tools and resources.
 * Pass the provider to `initWeldall(..., { mcp, ... })`; each HTTP request gets a stateless protocol
 * instance. Recreate the provider to change definitions. Business/record-level checks belong in handlers.
 * @param options Endpoint, discovery policy and the complete catalog (not a per-caller filtered list).
 * @returns A provider for the Weldall HTTP adapters; creation alone does not start a server.
 */
export function createNativeMcp(options: {
  /** Absolute route path, e.g. `/api/mcp`, inside the registered resource's approved request prefixes. */
  path: string;
  /** Public description advertised in resource metadata; no secrets or per-user data. */
  description: string;
  /** Nonempty scopes ALL required for every MCP request, including initialization and listing. */
  discoveryScopes: readonly string[];
  /** Complete tool catalog, with unique names and separate operation scopes. May be empty. */
  tools: readonly NativeMcpTool[];
  /** Fixed resources available for reads, with unique URIs. Defaults to none; no resource templates. */
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
    const parsed = nativeMcpToolDefinitionSchema.parse(structuredClone(definition));
    if (parsed.inputSchema.$async || parsed.outputSchema?.$async)
      throw new TypeError("Native MCP schemas must be synchronous");
    const validate = validator.compile(parsed.inputSchema);
    const validateOutput = parsed.outputSchema ? validator.compile(parsed.outputSchema) : undefined;
    return {
      definition: {
        ...parsed,
        _meta: {
          ...(parsed._meta?.ui ? { ui: { ...parsed._meta.ui, visibility: ["model"] } } : {}),
          "weldall/scopes": nativeMcpScopesSchema.parse(scopes).sort(),
        },
      },
      validate,
      validateOutput,
      handler,
    };
  });
  const resources = (options.resources ?? []).map(({ scopes, handler, ...definition }) => {
    assertMcpJson(definition, MCP_LIMITS.definitionsBytes);
    const parsed = nativeMcpResourceDefinitionSchema.parse(structuredClone(definition));
    return {
      definition: {
        ...parsed,
        _meta: {
          ...(parsed._meta?.ui ? { ui: parsed._meta.ui } : {}),
          "weldall/scopes": nativeMcpScopesSchema.parse(scopes).sort(),
        },
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
  for (const resource of resources) {
    const allowed = resource.definition._meta.ui?.allowedTools ?? [];
    if (
      allowed.length &&
      (resource.definition.mimeType !== MCP_APP_MIME_TYPE ||
        !resource.definition.uri.startsWith("ui://") ||
        allowed.some((name) => !tools.some((tool) => tool.definition.name === name)))
    )
      throw new TypeError("UI allowedTools must reference tools in this resource catalog");
  }
  for (const tool of tools) {
    const uri = tool.definition._meta.ui?.resourceUri;
    if (
      uri &&
      !resources.some(
        (resource) =>
          resource.definition.uri === uri && resource.definition.mimeType === MCP_APP_MIME_TYPE,
      )
    )
      throw new TypeError("Native MCP App must reference a registered HTML UI resource");
  }
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
          return parseMcpResponse(
            nativeMcpReadResultSchema,
            await resource.handler({ auth, signal }),
          );
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
