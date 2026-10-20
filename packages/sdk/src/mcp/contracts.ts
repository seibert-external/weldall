import { z } from "zod";
import { connectorCapabilitiesSchema } from "../connectors.js";
import { McpBoundaryError } from "./errors.js";

export const MCP_LIMITS = Object.freeze({
  tools: 100,
  resources: 100,
  pages: 20,
  definitionsBytes: 1024 * 1024,
  requestBytes: 1024 * 1024,
  resultBytes: 10 * 1024 * 1024,
  descriptionBytes: 16 * 1024,
  uriBytes: 8192,
  cursorBytes: 1024,
  jsonDepth: 16,
  jsonNodes: 20_000,
  initializeMs: 10_000,
  discoveryMs: 20_000,
  operationMs: 30_000,
});

const bytes = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maximum)
    .meta({ "x-weldall-maxBytes": maximum });
export const mcpConnectorKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/);
export const mcpToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
export const mcpUriSchema = bytes(MCP_LIMITS.uriBytes)
  .min(1)
  .refine((value) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\x00-\x1f\x7f]*$/.test(value));
const description = bytes(MCP_LIMITS.descriptionBytes);
const title = bytes(512).min(1);
const cursor = bytes(MCP_LIMITS.cursorBytes).min(1);

/** Bound traversal before schema parsing/stringification; reject cycles and non-JSON objects. */
export function assertMcpJson(value: unknown, maximum = MCP_LIMITS.resultBytes): void {
  const pending = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringBytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    nodes++;
    if (item.depth > MCP_LIMITS.jsonDepth || nodes > MCP_LIMITS.jsonNodes)
      throw new McpBoundaryError("response_too_large");
    const current = item.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (typeof current === "string") {
      stringBytes += Buffer.byteLength(current, "utf8");
      if (stringBytes > maximum) throw new McpBoundaryError("response_too_large");
      continue;
    }
    if (
      typeof current !== "object" ||
      seen.has(current) ||
      (!Array.isArray(current) &&
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null)
    )
      throw new McpBoundaryError("upstream_protocol_error");
    seen.add(current);
    const entries = Object.entries(current);
    if (entries.length + pending.length + nodes > MCP_LIMITS.jsonNodes)
      throw new McpBoundaryError("response_too_large");
    for (const [key, child] of entries) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new McpBoundaryError("upstream_protocol_error");
      stringBytes += Buffer.byteLength(key, "utf8");
      if (stringBytes > maximum) throw new McpBoundaryError("response_too_large");
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum)
    throw new McpBoundaryError("response_too_large");
}

const jsonObject = z.record(z.string(), z.unknown());
const objectSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), jsonObject).optional(),
    required: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());
const annotations = z.object({
  audience: z
    .array(z.enum(["user", "assistant"]))
    .max(2)
    .optional(),
  priority: z.number().min(0).max(1).optional(),
  lastModified: z.iso.datetime({ offset: true }).optional(),
});
const resourceMetadata = {
  uri: mcpUriSchema,
  name: title,
  title: title.optional(),
  description: description.optional(),
  mimeType: bytes(255).min(1).optional(),
  size: z.number().int().nonnegative().max(MCP_LIMITS.resultBytes).optional(),
  annotations: annotations.optional(),
};

// Explicitly project supported protocol fields. Unknown extension metadata (notably _meta.ui)
// is never forwarded. The complete incoming JSON must pass parseMcpResponse's budget first.
export const mcpToolSchema = z.object({
  name: mcpToolNameSchema,
  title: title.optional(),
  description: description.optional(),
  inputSchema: objectSchema,
  outputSchema: objectSchema.optional(),
  annotations: z
    .object({
      title: title.optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
});
export const mcpResourceSchema = z.object(resourceMetadata);
const base64 = bytes(MCP_LIMITS.resultBytes).refine(
  (value) =>
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value,
);
const resourceContents = z.union([
  z.object({
    uri: mcpUriSchema,
    mimeType: bytes(255).optional(),
    text: bytes(MCP_LIMITS.resultBytes),
    blob: z.never().optional(),
  }),
  z.object({
    uri: mcpUriSchema,
    mimeType: bytes(255).optional(),
    blob: base64,
    text: z.never().optional(),
  }),
]);
const content = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: bytes(MCP_LIMITS.resultBytes),
    annotations: annotations.optional(),
  }),
  z.object({
    type: z.literal("image"),
    data: base64,
    mimeType: bytes(255).min(1),
    annotations: annotations.optional(),
  }),
  z.object({
    type: z.literal("audio"),
    data: base64,
    mimeType: bytes(255).min(1),
    annotations: annotations.optional(),
  }),
  z.object({ type: z.literal("resource_link"), ...resourceMetadata }),
  z.object({
    type: z.literal("resource"),
    resource: resourceContents,
    annotations: annotations.optional(),
  }),
]);
export const mcpToolsPageSchema = z.object({
  tools: z.array(mcpToolSchema).max(MCP_LIMITS.tools),
  nextCursor: cursor.optional(),
});
export const mcpResourcesPageSchema = z.object({
  resources: z.array(mcpResourceSchema).max(MCP_LIMITS.resources),
  nextCursor: cursor.optional(),
});
export const mcpCallResultSchema = z.object({
  content: z.array(content).max(100),
  structuredContent: jsonObject.optional(),
  isError: z.boolean().optional(),
});
export const mcpReadResultSchema = z.object({ contents: z.array(resourceContents).max(100) });

export function parseMcpResponse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  maximum = MCP_LIMITS.resultBytes,
): z.output<S> {
  assertMcpJson(value, maximum);
  const result = schema.safeParse(value);
  if (!result.success) throw new McpBoundaryError("upstream_protocol_error");
  return result.data;
}

export const exactMcpDependencySchema = z
  .strictObject({
    connectorKey: mcpConnectorKeySchema,
    tools: z
      .array(mcpToolNameSchema)
      .max(32)
      .transform((tools) => [...new Set(tools)].sort()),
    includeResources: z.boolean(),
  })
  .refine((value) => value.tools.length > 0 || value.includeResources);
export const skillMcpDependencySchema = z.union([
  exactMcpDependencySchema,
  z.strictObject({ kind: z.literal("resource"), resourceKey: mcpConnectorKeySchema }),
  z.strictObject({ kind: z.literal("connector"), connectorType: mcpConnectorKeySchema }),
]);
export type SkillMcpDependency = z.output<typeof skillMcpDependencySchema>;
export type ExactMcpDependency = z.output<typeof exactMcpDependencySchema>;

export function mcpDependencyKey(dependency: SkillMcpDependency): string {
  return "connectorKey" in dependency
    ? `connector:${dependency.connectorKey}`
    : dependency.kind === "resource"
      ? `resource:${dependency.resourceKey}`
      : `connector-type:${dependency.connectorType}`;
}

export const skillMcpDependenciesSchema = z
  .array(skillMcpDependencySchema)
  .max(8)
  .refine((items) => new Set(items.map(mcpDependencyKey)).size === items.length)
  .transform((items) =>
    [...items].sort((a, b) =>
      mcpDependencyKey(a) < mcpDependencyKey(b)
        ? -1
        : mcpDependencyKey(a) > mcpDependencyKey(b)
          ? 1
          : 0,
    ),
  );

export const mcpConnectionSelectionSchema = z.strictObject({
  connection: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/),
});
export const mcpToolCallSchema = mcpConnectionSelectionSchema.extend({
  name: mcpToolNameSchema,
  arguments: jsonObject,
});
export const mcpResourceReadSchema = mcpConnectionSelectionSchema.extend({ uri: mcpUriSchema });
export const mcpConnectorsSchema = z
  .array(
    z.strictObject({
      key: mcpConnectorKeySchema,
      name: z.string().min(1).max(200),
      capabilities: connectorCapabilitiesSchema,
    }),
  )
  .max(1000);
export const mcpConnectionSchema = z
  .strictObject({
    id: z.string().min(1).max(160),
    key: mcpConnectorKeySchema.nullable(),
    accessMode: z.enum(["OWNER_ONLY", "SCOPED"]),
    connectorKey: mcpConnectorKeySchema,
    name: z.string().min(1).max(200),
    accountName: z.string().min(1).max(200),
    status: z.enum(["READY", "DISABLED", "REFRESHING", "RECONNECT_REQUIRED", "REVOCATION_PENDING"]),
    connectorEnabled: z.boolean(),
    capabilities: connectorCapabilitiesSchema,
    useScopes: z.array(z.string().min(1).max(160)).max(100),
  })
  .refine((row) =>
    row.accessMode === "SCOPED"
      ? row.key !== null && row.useScopes.length > 0
      : row.key === null && row.useScopes.length === 0,
  );
export const mcpConnectionsSchema = z.array(mcpConnectionSchema).max(200);
export type McpConnection = z.output<typeof mcpConnectionSchema>;

export const mcpToolsResponseSchema = z.strictObject({
  tools: z.array(mcpToolSchema).max(MCP_LIMITS.tools),
});
export const mcpResourcesResponseSchema = z.strictObject({
  resources: z.array(mcpResourceSchema).max(MCP_LIMITS.resources),
});
