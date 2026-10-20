import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Tool, CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_LIMITS,
  DISCOVERY_LIMITS,
  nativeDiscoveryRequestSchema,
  nativeDiscoveryResponseSchema,
  type NativeMcpRoute,
  type NativeDiscoveryRequest,
  type DiscoveryEntry,
  type ExactMcpDependency,
  discoveryBindingSchema,
  connectorCapabilitiesSchema,
  assertMcpJson,
  mcpConnectorsSchema,
  mcpToolsResponseSchema,
  mcpResourcesResponseSchema,
  mcpCallResultSchema,
  mcpReadResultSchema,
  nativeMcpReadResultSchema,
  nativeMcpResourceDefinitionSchema,
  MCP_APP_MIME_TYPE,
  localMcpAppResourceUri,
  mcpConnectorKeySchema,
  mcpConnectionSelectionSchema,
  skillMcpDependenciesSchema,
  localMcpToolName,
  localMcpResourceUri,
  parseMcpResponse,
  type SkillMcpDependency,
} from "@weldall/sdk/mcp";
import { sanitizeMcpDisplayHtml } from "@weldall/sdk/mcp/display";
import type { CliRunner } from "./cli.js";
import { ExtensionError } from "./errors.js";

const connectionsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(160),
      name: z.string().min(1).max(200),
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
    "Continue a pending skill dependency after the user explicitly chooses an account. Pass its ID from the offered choices. Never pick the first account. A connector cannot switch accounts in this session.",
  inputSchema: {
    type: "object",
    properties: { connectorKey: { type: "string" }, connection: { type: "string" } },
    required: ["connectorKey", "connection"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};
const discoveryTool: Tool = {
  name: "discover_integrations",
  description:
    "Search authorized integrations or select registered resources, connector types and skills. Successful sources become tools for the next model request. catalogOnly returns descriptions without activation. Follow nextCursor only when relevant; ask the user to choose ambiguous accounts.",
  inputSchema: {
    type: "object",
    properties: {
      resources: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: DISCOVERY_LIMITS.sources,
      },
      connectorTypes: {
        type: "array",
        items: { type: "string" },
        maxItems: DISCOVERY_LIMITS.sources,
      },
      skills: { type: "array", items: { type: "string" }, maxItems: DISCOVERY_LIMITS.sources },
      remove: {
        type: "array",
        items: { type: "string" },
        maxItems: DISCOVERY_LIMITS.sources,
        description:
          "Remove published source IDs from this session; do not combine with discovery selectors",
      },
      query: { type: "string" },
      cursor: { type: "string" },
      catalogOnly: { type: "boolean" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};
const uiCallSchema = z.strictObject({
  viewToken: z.uuid(),
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const uiCallTool: Tool = {
  name: "call_resource_ui_tool",
  description:
    "Host-only dispatch for a bound native Resource view. Never select a source from UI arguments.",
  inputSchema: {
    type: "object",
    properties: {
      viewToken: { type: "string" },
      name: { type: "string" },
      arguments: { type: "object" },
    },
    required: ["viewToken", "name"],
    additionalProperties: false,
  },
  _meta: { ui: { visibility: ["app"] } },
};
const uiReadSchema = z.strictObject({
  viewToken: z.uuid(),
  uri: z.string().min(1).max(8192).optional(),
});
const uiReadTool: Tool = {
  name: "read_resource_ui_resource",
  description:
    "Host-only resource access for a bound native view. Omit uri to list its own catalog.",
  inputSchema: {
    type: "object",
    properties: { viewToken: { type: "string" }, uri: { type: "string" } },
    required: ["viewToken"],
    additionalProperties: false,
  },
  _meta: { ui: { visibility: ["app"] } },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
type Resource = z.output<typeof nativeMcpResourceDefinitionSchema>;
type Binding = {
  connectionId: string;
  dependency: ExactMcpDependency;
};
type NativeBinding = NativeMcpRoute & { issuer: string; subject: string };
type Routing =
  | { native: NativeBinding; namespace: string }
  | {
      native?: undefined;
      connectorKey: string;
      connectionId: string;
      namespace?: string;
      session?: { issuer: string; subject: string };
    };
type ToolBinding = Routing & { upstreamName: string; definition: Tool };
type ResourceBinding = Routing & { upstreamUri: string; definition?: Resource };

/** Session-local context only. All operations are reauthorized by Weldall via the fixed CLI. */
export class McpActivation {
  private bindings = new Map<string, Binding>();
  private pending = new Map<string, ExactMcpDependency>();
  private sessionBindings = new Map<string, z.output<typeof discoveryBindingSchema>>();
  private pendingDiscovery = new Map<
    string,
    {
      request: NativeDiscoveryRequest;
      entry: Extract<DiscoveryEntry, { status: "selection_required" }>;
    }
  >();
  private tools = new Map<string, ToolBinding>();
  private resources = new Map<string, ResourceBinding>();
  // Opaque host-only handles. Never inserted into HTML or supplied by the iframe.
  private uiViews = new Map<string, { uri: string; binding: ResourceBinding }>();
  private nativeIdentity: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private sharedDiscovery:
    | {
        key: string;
        controller: AbortController;
        promise: Promise<CallToolResult>;
        waiters: number;
      }
    | undefined;
  constructor(
    private cli: CliRunner,
    private changed: { tools(): Promise<void>; resources(): Promise<void> },
  ) {}
  listTools(): Tool[] {
    return [
      ...(this.cli.nativeDiscoveryVersion === 1 ? [discoveryTool] : []),
      ...(this.hasInteractiveViews() ? [uiCallTool] : []),
      ...(this.hasNativeViews() ? [uiReadTool] : []),
      ...(this.pending.size || this.pendingDiscovery.size ? [selectionTool] : []),
      ...[...this.tools.values()].map((t) => t.definition),
    ];
  }
  listResources(): Resource[] {
    return [...this.resources.values()].flatMap((r) => (r.definition ? [r.definition] : []));
  }
  hasTool(name: string) {
    return (
      this.tools.has(name) ||
      (name === uiCallTool.name && this.hasInteractiveViews()) ||
      (name === uiReadTool.name && this.hasNativeViews()) ||
      (name === selectionTool.name && (this.pending.size > 0 || this.pendingDiscovery.size > 0)) ||
      (name === discoveryTool.name && this.cli.nativeDiscoveryVersion === 1)
    );
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
  private discoverShared(input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    signal?.throwIfAborted();
    if (input && typeof input === "object" && "remove" in input) {
      this.sharedDiscovery = undefined;
      return this.exclusive(() => this.discoverNative(input, signal));
    }
    const request = nativeDiscoveryRequestSchema.parse(input);
    const key = JSON.stringify(request);
    let shared = this.sharedDiscovery;
    if (!shared || shared.key !== key || shared.controller.signal.aborted) {
      const controller = new AbortController();
      shared = {
        key,
        controller,
        waiters: 0,
        promise: this.exclusive(() => this.discoverNative(request, controller.signal)),
      };
      this.sharedDiscovery = shared;
      const current = shared;
      const done = () => {
        if (this.sharedDiscovery === current) this.sharedDiscovery = undefined;
      };
      void shared.promise.then(done, done);
    }
    if (shared.waiters >= 16) return Promise.reject(new ExtensionError("busy"));
    const current = shared;
    current.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const detach = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", cancel);
        current.waiters--;
        return true;
      };
      const cancel = () => {
        if (!detach()) return;
        if (!current.waiters) current.controller.abort();
        reject(new ExtensionError("cancelled"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void current.promise.then(
        (value) => {
          if (detach()) resolve(value);
        },
        (error: unknown) => {
          if (detach()) reject(error);
        },
      );
      if (signal?.aborted) cancel();
    });
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
  private nativeGuards(route: NativeBinding): string[] {
    return [
      `--expected-issuer=${route.issuer}`,
      `--expected-subject=${route.subject}`,
      `--expected-revision=${route.revision}`,
      `--expected-resource-identifier=${route.resourceIdentifier}`,
    ];
  }
  private async discoverNative(input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    signal?.throwIfAborted();
    if (input && typeof input === "object" && "remove" in input) {
      const { remove } = z
        .strictObject({
          remove: z
            .array(z.string().regex(/^(resource|connector):[a-z0-9][a-z0-9._-]{0,119}$/))
            .min(1)
            .max(DISCOVERY_LIMITS.sources),
        })
        .parse(input);
      const ids = new Set(remove);
      const belongs = (binding: Routing) =>
        ids.has(
          binding.native
            ? `resource:${binding.native.resourceKey}`
            : `connector:${binding.connectorKey}`,
        );
      this.tools = new Map([...this.tools].filter(([, binding]) => !belongs(binding)));
      this.resources = new Map([...this.resources].filter(([, binding]) => !belongs(binding)));
      for (const [key, pending] of this.pendingDiscovery)
        if (
          ids.has(key) ||
          pending.entry.choices.some((choice) => ids.has(`connector:${choice.connectorKey}`))
        )
          this.pendingDiscovery.delete(key);
      // Keep the account choice for this activation instance; removal cannot bypass no-rebind.
      await this.changed.tools();
      await this.changed.resources();
      const results = [...ids].map((id) => ({ id, status: "inactive" }));
      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        structuredContent: { results },
      };
    }
    const request = nativeDiscoveryRequestSchema.parse(input);
    const identity = this.nativeIdentity
      ? (JSON.parse(this.nativeIdentity) as [string, string])
      : undefined;
    const discovered = await this.run(
      nativeDiscoveryResponseSchema,
      [
        "discover",
        ...request.resources.map((key) => `--resource=${key}`),
        ...request.connectorTypes.map((key) => `--connector-type=${key}`),
        ...request.skills.map((key) => `--skill=${key}`),
        ...(request.query ? [`--query=${request.query}`] : []),
        ...(request.cursor ? [`--cursor=${request.cursor}`] : []),
        ...(request.dependencies ? [`--dependencies=${JSON.stringify(request.dependencies)}`] : []),
        ...(request.selection ? [`--selection=${JSON.stringify(request.selection)}`] : []),
        ...(this.sessionBindings.size
          ? [`--bindings=${JSON.stringify([...this.sessionBindings.values()])}`]
          : []),
        ...(identity
          ? [`--expected-issuer=${identity[0]}`, `--expected-subject=${identity[1]}`]
          : []),
        ...(request.catalogOnly ? ["--catalog-only"] : []),
        "--json",
      ],
      signal,
    );
    if (discovered.resetRequired) {
      this.tools.clear();
      this.resources.clear();
      this.bindings.clear();
      this.pending.clear();
      this.sessionBindings.clear();
      this.pendingDiscovery.clear();
      this.nativeIdentity = undefined;
      await this.changed.tools();
      await this.changed.resources();
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "The signed-in identity or Weldall origin changed. Old routes were removed. Discover again in the new context.",
          },
        ],
        structuredContent: { results: [], resetRequired: discovered.resetRequired },
      };
    }
    if (
      (request.catalogOnly &&
        discovered.results.some(
          (entry) => entry.status === "resolved" || entry.status === "incomplete",
        )) ||
      (!request.query &&
        !request.skills.length &&
        !request.connectorTypes.length &&
        !request.dependencies?.length &&
        (discovered.results.length !== new Set(request.resources).size ||
          discovered.results.some(
            (entry) => entry.kind !== "resource" || !request.resources.includes(entry.key),
          )))
    )
      throw new ExtensionError("invalid_response");
    signal?.throwIfAborted();
    const nextIdentity = JSON.stringify([discovered.issuer, discovered.subject]);
    const beforeTools = JSON.stringify(this.listTools()),
      beforeResources = JSON.stringify(this.listResources());
    if (this.nativeIdentity !== undefined && this.nativeIdentity !== nextIdentity) {
      this.tools.clear();
      this.resources.clear();
      this.bindings.clear();
      this.pending.clear();
      this.sessionBindings.clear();
      this.pendingDiscovery.clear();
    }
    this.nativeIdentity = nextIdentity;
    const outcomes: Record<string, unknown>[] = [];
    const active = new Set<string>();
    for (const entry of discovered.results) {
      if (entry.kind === "skill") continue;
      if (entry.status === "selection_required") {
        this.pendingDiscovery.set(entry.id, { request, entry });
        outcomes.push(entry);
        continue;
      }
      if (entry.status !== "resolved") {
        outcomes.push(entry);
        continue;
      }
      const { kind, id, key, name, description } = entry;
      const native: NativeBinding | undefined =
        entry.kind === "resource"
          ? { ...entry.route, issuer: discovered.issuer, subject: discovered.subject }
          : undefined;
      const namespace =
        (native ? "native-" : "connector-") +
        createHash("sha256")
          .update(JSON.stringify([discovered.issuer, discovered.subject, id, entry.route]))
          .digest("hex")
          .slice(0, 32);
      const routing: Routing =
        entry.kind === "resource"
          ? { native: native!, namespace }
          : {
              connectorKey: entry.route.connectorKey,
              connectionId: entry.route.connectionId,
              namespace,
              session: { issuer: discovered.issuer, subject: discovered.subject },
            };
      const sameSource = (binding: Routing) =>
        binding.native
          ? kind === "resource" && binding.native.resourceKey === key
          : kind === "connector" && binding.connectorKey === key;
      const tools = new Map([...this.tools].filter(([, binding]) => !sameSource(binding)));
      const resources = new Map([...this.resources].filter(([, binding]) => !sameSource(binding)));
      if (
        entry.kind === "connector" &&
        [...this.sessionBindings.values()].some(
          (bound) => bound.connectorKey === key && bound.connectionId !== entry.route.connectionId,
        )
      ) {
        outcomes.push({
          id,
          kind,
          key,
          status: "unavailable",
          code: "bound_connection_unavailable",
        });
        continue;
      }
      try {
        for (const definition of entry.tools) {
          // Leave nine characters for Goose’s "weldall__" prefix within the 64-character limit.
          const readable = `${native ? "native" : "mcp"}_${definition.name}`
            .replace(/[^A-Za-z0-9_-]/g, "_")
            .slice(0, 42);
          const suffix = createHash("sha256")
            .update(JSON.stringify([namespace, definition.name]))
            .digest("hex")
            .slice(0, 12);
          const local = `${readable}_${suffix}`;
          if (tools.has(local)) throw new ExtensionError("invalid_response");
          const ui =
            entry.kind === "resource" && "_meta" in definition ? definition._meta?.ui : undefined;
          if (
            ui &&
            !entry.resources.some(
              (resource) =>
                resource.uri === ui.resourceUri && resource.mimeType === MCP_APP_MIME_TYPE,
            )
          )
            throw new ExtensionError("invalid_response");
          tools.set(local, {
            ...routing,
            upstreamName: definition.name,
            definition: {
              ...definition,
              name: local,
              ...(ui
                ? {
                    _meta: {
                      ui: {
                        resourceUri: localMcpAppResourceUri(namespace, ui.resourceUri),
                        visibility: ["model"],
                      },
                    },
                  }
                : {}),
            },
          });
        }
        for (const definition of entry.resources) {
          const uri =
            native && definition.uri.startsWith("ui://")
              ? localMcpAppResourceUri(namespace, definition.uri)
              : localMcpResourceUri(namespace, definition.uri);
          resources.set(uri, {
            ...routing,
            upstreamUri: definition.uri,
            definition: { ...definition, uri },
          });
        }
        const sources = new Set(
          [...tools.values(), ...resources.values()].map((binding) =>
            binding.native
              ? `resource:${binding.native.resourceKey}`
              : `connector:${binding.connectorKey}`,
          ),
        );
        if (
          sources.size > DISCOVERY_LIMITS.sources ||
          tools.size > DISCOVERY_LIMITS.tools ||
          resources.size > DISCOVERY_LIMITS.resources
        )
          throw new ExtensionError("output_limit");
        assertMcpJson(
          {
            tools: [...tools.values()].map((binding) => binding.definition),
            resources: [...resources.values()].flatMap((binding) =>
              binding.definition ? [binding.definition] : [],
            ),
          },
          DISCOVERY_LIMITS.bytes,
        );
        const bindings = new Map(this.sessionBindings);
        if (entry.kind === "connector")
          for (const selector of entry.selectors) {
            bindings.set(selector, {
              selector,
              connectorKey: key,
              connectionId: entry.route.connectionId,
              whole: entry.whole,
              tools: entry.whole ? [] : entry.tools.map((tool) => tool.name),
              includeResources: entry.resources.length > 0,
            });
          }
        const savedBindings = nativeDiscoveryRequestSchema.shape.bindings.parse([
          ...bindings.values(),
        ]);
        // Reserve half the CLI argument budget for selectors and identity guards.
        if (JSON.stringify(savedBindings).length > 12_000) throw new ExtensionError("output_limit");
        this.tools = tools;
        this.resources = resources;
        this.sessionBindings = bindings;
        if (entry.kind === "connector")
          for (const selector of entry.selectors) this.pendingDiscovery.delete(selector);
        active.add(id);
        outcomes.push({
          id,
          kind,
          key,
          name,
          description,
          status: "active",
          tools: entry.tools.length,
          resources: entry.resources.length,
        });
      } catch {
        outcomes.push({ id, kind, key, status: "unavailable", code: "capacity" });
      }
    }
    for (const entry of discovered.results) {
      if (entry.kind !== "skill") continue;
      if (entry.status === "resolved" || entry.status === "incomplete") {
        const complete =
          entry.status === "resolved" && entry.dependencies.every((id) => active.has(id));
        outcomes.push({ ...entry, status: complete ? "active" : "incomplete" });
      } else outcomes.push(entry);
    }
    // Publication is committed before either notification and before returning instructions.
    if (beforeTools !== JSON.stringify(this.listTools())) await this.changed.tools();
    if (beforeResources !== JSON.stringify(this.listResources())) await this.changed.resources();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: outcomes,
            nextCursor: discovered.nextCursor,
            warnings: discovered.warnings,
          }),
        },
      ],
      structuredContent: {
        results: outcomes,
        ...(discovered.nextCursor ? { nextCursor: discovered.nextCursor } : {}),
        ...(discovered.warnings ? { warnings: discovered.warnings } : {}),
      },
    };
  }
  activate(dependencies: SkillMcpDependency[], signal?: AbortSignal) {
    return this.exclusive(async () => {
      const parsed = skillMcpDependenciesSchema.parse(dependencies);
      if (this.cli.nativeDiscoveryVersion === 1)
        return (await this.discoverNative({ dependencies: parsed }, signal)).structuredContent;
      if (parsed.some((dependency) => !("connectorKey" in dependency)))
        throw new ExtensionError("mcp_unavailable");
      return this.prepare(parsed as ExactMcpDependency[], undefined, signal);
    });
  }
  readSkill(slug: string, signal?: AbortSignal) {
    return this.discoverShared({ skills: [slug] }, signal);
  }
  private async prepare(
    dependencies: ExactMcpDependency[],
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
      const named = candidates.filter((c) => c.name === selected?.connection);
      const explicit =
        selected?.connectorKey === dependency.connectorKey
          ? (candidates.find((c) => c.id === selected.connection) ??
            (named.length === 1 ? named[0] : undefined))
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
          choices: candidates.map(({ id, name, accountName, details }) => ({
            id,
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
        ...(this.cli.nativeDiscoveryVersion === 1 ? [discoveryTool] : []),
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
  private hasNativeViews() {
    return (
      this.cli.nativeDiscoveryVersion === 1 &&
      [...this.resources.values()].some(
        (binding) => binding.native && binding.definition?.mimeType === MCP_APP_MIME_TYPE,
      )
    );
  }
  private getUiView(viewToken: string) {
    const view = this.uiViews.get(viewToken);
    if (!view || this.resources.get(view.uri) !== view.binding || !view.binding.native)
      throw new ExtensionError("invalid_request");
    return view;
  }
  private async readFromUi(input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    assertMcpJson(input, MCP_LIMITS.requestBytes);
    const args = uiReadSchema.parse(input);
    const view = this.getUiView(args.viewToken);
    const own = [...this.resources.entries()].filter(
      ([, candidate]) =>
        candidate.native === view.binding.native && candidate.namespace === view.binding.namespace,
    );
    let result: Record<string, unknown>;
    if (args.uri !== undefined) {
      const match = own.find(([, candidate]) => candidate.upstreamUri === args.uri);
      if (!match) throw new ExtensionError("invalid_request");
      const read = await this.read(match[0], signal, false);
      this.getUiView(args.viewToken);
      result = {
        contents: read.contents.map((item) => ({
          ...item,
          uri: this.resources.get(item.uri)?.upstreamUri ?? args.uri,
        })),
      };
    } else {
      result = {
        resources: own.flatMap(([, candidate]) =>
          candidate.definition ? [{ ...candidate.definition, uri: candidate.upstreamUri }] : [],
        ),
      };
    }
    const output = { content: [], structuredContent: result };
    assertMcpJson(output, MCP_LIMITS.resultBytes);
    return output;
  }
  private hasInteractiveViews() {
    return (
      this.cli.nativeDiscoveryVersion === 1 &&
      [...this.resources.values()].some(
        (binding) =>
          binding.native &&
          binding.definition?.mimeType === MCP_APP_MIME_TYPE &&
          binding.definition._meta?.ui?.allowedTools.length,
      )
    );
  }
  private async callFromUi(input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    assertMcpJson(input, MCP_LIMITS.requestBytes);
    const args = uiCallSchema.parse(input);
    const view = this.getUiView(args.viewToken);
    if (!view.binding.definition?._meta?.ui?.allowedTools.includes(args.name))
      throw new ExtensionError("invalid_request");
    const tool = [...this.tools.entries()].find(
      ([, candidate]) =>
        candidate.native &&
        candidate.namespace === view.binding.namespace &&
        candidate.upstreamName === args.name &&
        candidate.native === view.binding.native,
    );
    if (!tool) throw new ExtensionError("invalid_request");
    // Reuse exact issuer/subject/revision/resource guards and live scope authorization. Never retry.
    return this.call(tool[0], args.arguments, signal);
  }
  async call(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    if (name === uiCallTool.name) return this.callFromUi(args, signal);
    if (name === uiReadTool.name) return this.readFromUi(args, signal);
    if (name === discoveryTool.name && this.cli.nativeDiscoveryVersion === 1)
      return this.discoverShared(args, signal);
    if (name === selectionTool.name) {
      this.sharedDiscovery = undefined;
      const selection = selectionSchema.safeParse(args);
      if (!selection.success) throw new ExtensionError("invalid_request");
      return this.exclusive(async () => {
        if (this.cli.nativeDiscoveryVersion === 1) {
          const pending = [...this.pendingDiscovery.values()].find(({ entry }) =>
            entry.choices.some(
              (choice) =>
                choice.connectorKey === selection.data.connectorKey &&
                choice.connectionId === selection.data.connection,
            ),
          );
          if (!pending) throw new ExtensionError("mcp_selection");
          return this.discoverNative({ ...pending.request, selection: selection.data }, signal);
        }
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
      binding.native
        ? [
            "mcp",
            "native",
            "call",
            binding.native.resourceKey,
            binding.upstreamName,
            ...this.nativeGuards(binding.native),
            `--arguments=${JSON.stringify(args ?? {})}`,
            "--json",
          ]
        : [
            "mcp",
            "call",
            binding.connectorKey,
            binding.upstreamName,
            `--connection=${binding.connectionId}`,
            ...(binding.session
              ? [
                  `--expected-issuer=${binding.session.issuer}`,
                  `--expected-subject=${binding.session.subject}`,
                ]
              : []),
            `--arguments=${JSON.stringify(args ?? {})}`,
            "--json",
          ],
      signal,
      true,
    );
    return this.exclusive(async () => {
      // An in-flight result must not revive routes removed by refresh or an identity change.
      if (this.tools.get(name) !== binding) return result;
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
  private mapUri(map: Map<string, ResourceBinding>, binding: Routing, upstreamUri: string) {
    const uri = (
      binding.native && upstreamUri.startsWith("ui://")
        ? localMcpAppResourceUri
        : localMcpResourceUri
    )(
      binding.namespace ?? (binding.native ? binding.native.resourceKey : binding.connectorKey),
      upstreamUri,
    );
    if (!map.has(uri)) {
      if (map.size >= 2000) throw new ExtensionError("output_limit");
      map.set(uri, {
        ...(binding.native
          ? { native: binding.native, namespace: binding.namespace }
          : {
              connectorKey: binding.connectorKey,
              connectionId: binding.connectionId,
              ...(binding.namespace ? { namespace: binding.namespace } : {}),
              ...(binding.session ? { session: binding.session } : {}),
            }),
        upstreamUri,
      });
    }
    return uri;
  }
  async read(uri: string, signal?: AbortSignal, bindView = true): Promise<ReadResourceResult> {
    const binding = this.resources.get(uri);
    if (!binding) throw new ExtensionError("invalid_request");
    const result = await this.run(
      binding.native ? nativeMcpReadResultSchema : mcpReadResultSchema,
      binding.native
        ? [
            "mcp",
            "native",
            "read-resource",
            binding.native.resourceKey,
            ...this.nativeGuards(binding.native),
            `--uri=${binding.upstreamUri}`,
            "--json",
          ]
        : [
            "mcp",
            "read-resource",
            binding.connectorKey,
            `--connection=${binding.connectionId}`,
            ...(binding.session
              ? [
                  `--expected-issuer=${binding.session.issuer}`,
                  `--expected-subject=${binding.session.subject}`,
                ]
              : []),
            `--uri=${binding.upstreamUri}`,
            "--json",
          ],
      signal,
      true,
    );
    const contents = binding.native
      ? nativeMcpReadResultSchema.parse(result).contents.map((item) => {
          // A provider must not bypass sanitization by changing/omitting the response MIME type.
          if (
            !binding.upstreamUri.startsWith("ui://") &&
            binding.definition?.mimeType !== MCP_APP_MIME_TYPE &&
            item.mimeType !== MCP_APP_MIME_TYPE
          )
            return item;
          // The source binding, never the provider-declared CSP, authorizes asset origins.
          const origin = new URL(binding.native!.resourceIdentifier).origin;
          const domains = [origin];
          const html = item.text ?? Buffer.from(item.blob!, "base64").toString("utf8");
          return {
            uri: item.uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: sanitizeMcpDisplayHtml(html, origin),
            _meta: { ui: { csp: { resourceDomains: domains }, prefersBorder: true } },
          };
        })
      : result.contents;
    return this.exclusive(async () => {
      if (this.resources.get(uri) !== binding) {
        if (binding.native) throw new ExtensionError("invalid_request");
        return result;
      }
      const map = new Map(this.resources);
      let viewToken: string | undefined;
      if (bindView && binding.native && binding.definition?.mimeType === MCP_APP_MIME_TYPE) {
        for (const [token, view] of this.uiViews)
          if (this.resources.get(view.uri) !== view.binding) this.uiViews.delete(token);
        if (this.uiViews.size >= 128) this.uiViews.delete(this.uiViews.keys().next().value!);
        viewToken = randomUUID();
        this.uiViews.set(viewToken, { uri, binding });
      }
      const output = {
        contents: contents.map((item) => ({
          ...item,
          uri: this.mapUri(map, binding, item.uri),
          ...(viewToken && item.mimeType === MCP_APP_MIME_TYPE
            ? {
                _meta: {
                  ...("_meta" in item && typeof item._meta === "object" && item._meta !== null
                    ? item._meta
                    : {}),
                  "weldall/resource-tool-calls": { version: 1, viewToken },
                },
              }
            : {}),
        })),
      };
      assertMcpJson(output, MCP_LIMITS.resultBytes);
      this.resources = map;
      return output;
    });
  }
}
