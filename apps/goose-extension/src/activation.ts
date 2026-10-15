import { z } from "zod";
import type { Tool, CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_LIMITS,
  connectorCapabilitiesSchema,
  assertMcpJson,
  mcpConnectorsSchema,
  mcpToolsResponseSchema,
  mcpResourcesResponseSchema,
  mcpCallResultSchema,
  mcpReadResultSchema,
  mcpConnectorKeySchema,
  mcpConnectionSelectionSchema,
  skillMcpDependenciesSchema,
  localMcpToolName,
  localMcpResourceUri,
  parseMcpResponse,
  type SkillMcpDependency,
} from "@weldall/sdk/mcp";
import type { CliRunner } from "./cli.js";
import { ExtensionError } from "./errors.js";

const connectionsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(160),
      name: z.string().min(1).max(160),
      connectorKey: z.string().min(1).max(120),
      connectorEnabled: z.boolean(),
      capabilities: connectorCapabilitiesSchema,
      status: z.string().max(50),
      accountName: z.string().max(500),
      details: z
        .array(z.object({ label: z.string().max(500), value: z.string().max(8192) }))
        .max(100)
        .optional(),
    }),
  )
  .max(10000);
const selectionSchema = mcpConnectionSelectionSchema.extend({
  connectorKey: mcpConnectorKeySchema,
});
const selectionTool: Tool = {
  name: "select_mcp_connection",
  title: "Select account for skill tools",
  description:
    "Continue a pending skill dependency after the user explicitly chooses an account. Never pick the first account. A connector cannot switch accounts in this session.",
  inputSchema: {
    type: "object",
    properties: { connectorKey: { type: "string" }, connection: { type: "string" } },
    required: ["connectorKey", "connection"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};
type Resource = z.output<typeof mcpResourcesResponseSchema>["resources"][number];
type Binding = {
  connectionId: string;
  dependency: SkillMcpDependency;
};
type ToolBinding = {
  connectorKey: string;
  connectionId: string;
  upstreamName: string;
  definition: Tool;
};
type ResourceBinding = {
  connectorKey: string;
  connectionId: string;
  upstreamUri: string;
  definition?: Resource;
};

/** Session-local context only. All operations are reauthorized by Weldall via the fixed CLI. */
export class McpActivation {
  private bindings = new Map<string, Binding>();
  private pending = new Map<string, SkillMcpDependency>();
  private tools = new Map<string, ToolBinding>();
  private resources = new Map<string, ResourceBinding>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  constructor(
    private cli: CliRunner,
    private changed: { tools(): Promise<void>; resources(): Promise<void> },
  ) {}
  listTools(): Tool[] {
    return [
      ...(this.pending.size ? [selectionTool] : []),
      ...[...this.tools.values()].map((t) => t.definition),
    ];
  }
  listResources(): Resource[] {
    return [...this.resources.values()].flatMap((r) => (r.definition ? [r.definition] : []));
  }
  hasTool(name: string) {
    return this.tools.has(name) || (name === selectionTool.name && this.pending.size > 0);
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queued >= 16) return Promise.reject(new ExtensionError("busy"));
    this.queued++;
    const next = this.tail.then(fn).finally(() => {
      this.queued--;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  private async run<S extends z.ZodType>(
    schema: S,
    args: string[],
    signal?: AbortSignal,
    result = false,
  ): Promise<z.output<S>> {
    if (args.join(" ").length > 24000 || args.some((arg) => arg.includes("\0")))
      throw new ExtensionError("invalid_request");
    const raw = await this.cli.run(
      args,
      signal,
      40_000,
      result ? 12 * 1024 * 1024 : 2 * 1024 * 1024,
    );
    try {
      return parseMcpResponse(
        schema,
        JSON.parse(raw),
        result ? MCP_LIMITS.resultBytes : MCP_LIMITS.definitionsBytes,
      );
    } catch {
      throw new ExtensionError("invalid_response");
    }
  }
  activate(dependencies: SkillMcpDependency[], signal?: AbortSignal) {
    return this.exclusive(() =>
      this.prepare(skillMcpDependenciesSchema.parse(dependencies), undefined, signal),
    );
  }
  private async prepare(
    dependencies: SkillMcpDependency[],
    selected?: { connectorKey: string; connection: string },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!dependencies.length) return [];
    const connectors = await this.run(mcpConnectorsSchema, ["mcp", "list", "--json"], signal);
    const connections = await this.run(connectionsSchema, ["connections", "--json"], signal);
    // The shipped connection catalog caps at 200. A truncated catalog cannot prove uniqueness.
    const completeCatalog = connections.length < 200;
    const tools = new Map(this.tools),
      resources = new Map(this.resources),
      bindings = new Map(this.bindings),
      pending = new Map(this.pending);
    const statuses: Record<string, unknown>[] = [];
    for (const dependency of dependencies) {
      const bound = bindings.get(dependency.connectorKey);
      const prior = bound?.dependency ?? pending.get(dependency.connectorKey);
      const merged = {
        ...dependency,
        tools: [...new Set([...dependency.tools, ...(prior?.tools ?? [])])].sort(),
        includeResources: dependency.includeResources || Boolean(prior?.includeResources),
      };
      if (
        merged.tools.length > MCP_LIMITS.tools ||
        (bindings.size + pending.size >= 32 && !bound && !prior)
      )
        throw new ExtensionError("output_limit");
      if (
        !connectors.some((c) => c.key === dependency.connectorKey && c.capabilities.includes("mcp"))
      )
        throw new ExtensionError("mcp_unavailable");
      const candidates = connections.filter(
        (c) =>
          c.connectorKey === dependency.connectorKey &&
          c.capabilities.includes("mcp") &&
          c.connectorEnabled &&
          c.status === "READY",
      );
      const explicit =
        selected?.connectorKey === dependency.connectorKey
          ? (candidates.find((c) => c.id === selected.connection) ??
            candidates.find((c) => c.name === selected.connection))
          : undefined;
      if (selected?.connectorKey === dependency.connectorKey && !explicit)
        throw new ExtensionError("mcp_selection");
      if (bound && explicit && explicit.id !== bound.connectionId)
        throw new ExtensionError("mcp_rebind");
      const connection = bound
        ? candidates.find((c) => c.id === bound.connectionId)
        : (explicit ?? (completeCatalog && candidates.length === 1 ? candidates[0] : undefined));
      if (bound && !connection) throw new ExtensionError("mcp_unavailable");
      if (!connection) {
        pending.set(dependency.connectorKey, merged);
        statuses.push({
          connectorKey: dependency.connectorKey,
          status:
            candidates.length || !completeCatalog ? "selection_required" : "connection_required",
          ...(!completeCatalog ? { catalogComplete: false } : {}),
          choices: candidates.map(({ name, accountName, details }) => ({
            name,
            accountName,
            ...(details ? { details } : {}),
          })),
        });
        continue;
      }
      if (
        bound &&
        merged.tools.every((t) => bound.dependency.tools.includes(t)) &&
        (!merged.includeResources || bound.dependency.includeResources)
      ) {
        statuses.push({ connectorKey: dependency.connectorKey, status: "active" });
        continue;
      }
      const discovered = await this.run(
        mcpToolsResponseSchema,
        ["mcp", "tools", dependency.connectorKey, `--connection=${connection.id}`, "--json"],
        signal,
      );
      const definitions = new Map(discovered.tools.map((tool) => [tool.name, tool]));
      if (merged.tools.some((name) => !definitions.has(name)))
        throw new ExtensionError("mcp_unavailable");
      const resourceList = merged.includeResources
        ? (
            await this.run(
              mcpResourcesResponseSchema,
              [
                "mcp",
                "resources",
                dependency.connectorKey,
                `--connection=${connection.id}`,
                "--json",
              ],
              signal,
            )
          ).resources
        : [];
      for (const name of merged.tools) {
        const local = localMcpToolName(dependency.connectorKey, name);
        tools.set(local, {
          connectorKey: dependency.connectorKey,
          connectionId: connection.id,
          upstreamName: name,
          definition: { ...definitions.get(name)!, name: local },
        });
      }
      for (const resource of resourceList) {
        const uri = localMcpResourceUri(dependency.connectorKey, resource.uri);
        resources.set(uri, {
          connectorKey: dependency.connectorKey,
          connectionId: connection.id,
          upstreamUri: resource.uri,
          definition: { ...resource, uri },
        });
      }
      bindings.set(dependency.connectorKey, {
        connectionId: connection.id,
        dependency: merged,
      });
      pending.delete(dependency.connectorKey);
      statuses.push({ connectorKey: dependency.connectorKey, status: "active" });
    }
    if (tools.size > 1000 || resources.size > 2000) throw new ExtensionError("output_limit");
    assertMcpJson(
      [...tools.values()].map((t) => t.definition),
      MCP_LIMITS.resultBytes,
    );
    signal?.throwIfAborted();
    const toolsChanged =
      JSON.stringify(this.listTools()) !==
      JSON.stringify([
        ...(pending.size ? [selectionTool] : []),
        ...[...tools.values()].map((t) => t.definition),
      ]);
    const resourcesChanged =
      JSON.stringify(this.listResources()) !==
      JSON.stringify([...resources.values()].flatMap((r) => (r.definition ? [r.definition] : [])));
    this.tools = tools;
    this.resources = resources;
    this.bindings = bindings;
    this.pending = pending;
    if (toolsChanged) await this.changed.tools();
    if (resourcesChanged) await this.changed.resources();
    return statuses;
  }
  async call(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    if (name === selectionTool.name) {
      const selection = selectionSchema.safeParse(args);
      if (!selection.success) throw new ExtensionError("invalid_request");
      return this.exclusive(async () => {
        const dependency = this.pending.get(selection.data.connectorKey);
        if (!dependency)
          throw new ExtensionError(
            this.bindings.has(selection.data.connectorKey) ? "mcp_rebind" : "mcp_selection",
          );
        const statuses = await this.prepare([dependency], selection.data, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(statuses) }],
          structuredContent: { mcpActivation: statuses },
        };
      });
    }
    const binding = this.tools.get(name);
    if (!binding) throw new ExtensionError("invalid_request");
    try {
      assertMcpJson(args ?? {}, MCP_LIMITS.requestBytes);
    } catch {
      throw new ExtensionError("invalid_request");
    }
    if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args)))
      throw new ExtensionError("invalid_request");
    const result = await this.run(
      mcpCallResultSchema,
      [
        "mcp",
        "call",
        binding.connectorKey,
        binding.upstreamName,
        `--connection=${binding.connectionId}`,
        `--arguments=${JSON.stringify(args ?? {})}`,
        "--json",
      ],
      signal,
      true,
    );
    return this.exclusive(async () => {
      const map = new Map(this.resources);
      const content = result.content.map((item) =>
        item.type === "resource_link"
          ? { ...item, uri: this.mapUri(map, binding, item.uri) }
          : item.type === "resource"
            ? {
                ...item,
                resource: { ...item.resource, uri: this.mapUri(map, binding, item.resource.uri) },
              }
            : item,
      );
      const output = { ...result, content };
      assertMcpJson(output, MCP_LIMITS.resultBytes);
      this.resources = map;
      return output;
    });
  }
  private mapUri(
    map: Map<string, ResourceBinding>,
    binding: { connectorKey: string; connectionId: string },
    upstreamUri: string,
  ) {
    const uri = localMcpResourceUri(binding.connectorKey, upstreamUri);
    if (!map.has(uri)) {
      if (map.size >= 2000) throw new ExtensionError("output_limit");
      map.set(uri, {
        connectorKey: binding.connectorKey,
        connectionId: binding.connectionId,
        upstreamUri,
      });
    }
    return uri;
  }
  async read(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    const binding = this.resources.get(uri);
    if (!binding) throw new ExtensionError("invalid_request");
    const result = await this.run(
      mcpReadResultSchema,
      [
        "mcp",
        "read-resource",
        binding.connectorKey,
        `--connection=${binding.connectionId}`,
        `--uri=${binding.upstreamUri}`,
        "--json",
      ],
      signal,
      true,
    );
    return this.exclusive(async () => {
      const map = new Map(this.resources);
      const output = {
        contents: result.contents.map((item) => ({
          ...item,
          uri: this.mapUri(map, binding, item.uri),
        })),
      };
      assertMcpJson(output, MCP_LIMITS.resultBytes);
      this.resources = map;
      return output;
    });
  }
}
