import { z } from "zod";
import {
  MCP_LIMITS,
  mcpConnectorKeySchema,
  mcpResourceSchema,
  mcpToolSchema,
  skillMcpDependenciesSchema,
} from "./contracts.js";

export const DISCOVERY_LIMITS = Object.freeze({
  sources: 8,
  entries: 72,
  tools: 200,
  resources: 200,
  bytes: 1024 * 1024,
  instructionBytes: 32 * 1024,
  concurrency: 4,
  deadlineMs: 35_000,
});
const skillKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/);
export const discoveryBindingSchema = z.strictObject({
  selector: z.string().min(1).max(280),
  connectorKey: mcpConnectorKeySchema,
  connectionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/),
  whole: z.boolean().default(false),
  tools: z.array(z.string().min(1).max(64)).max(MCP_LIMITS.tools).default([]),
  includeResources: z.boolean().default(false),
});
export const nativeDiscoveryRequestSchema = z
  .strictObject({
    resources: z.array(mcpConnectorKeySchema).max(DISCOVERY_LIMITS.sources).default([]),
    connectorTypes: z.array(mcpConnectorKeySchema).max(DISCOVERY_LIMITS.sources).default([]),
    skills: z.array(skillKey).max(DISCOVERY_LIMITS.sources).default([]),
    dependencies: skillMcpDependenciesSchema.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    cursor: z
      .string()
      .regex(/^[a-f0-9]{64}:[0-9]{1,5}$/)
      .optional(),
    bindings: z.array(discoveryBindingSchema).max(32).default([]),
    selection: z
      .strictObject({ connectorKey: mcpConnectorKeySchema, connection: z.string().min(1).max(160) })
      .optional(),
    expectedIssuer: z.url().optional(),
    expectedSubject: z.string().min(1).max(256).optional(),
    catalogOnly: z.boolean().default(false),
  })
  .refine((request) => {
    const selected =
      request.resources.length +
      request.connectorTypes.length +
      request.skills.length +
      (request.dependencies?.length ?? 0);
    return selected <= DISCOVERY_LIMITS.sources && (request.query ? selected === 0 : selected > 0);
  });
export const nativeMcpRouteSchema = z.strictObject({
  resourceKey: mcpConnectorKeySchema,
  resourceIdentifier: z.url().max(2000),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const connectorMcpRouteSchema = z.strictObject({
  connectorKey: mcpConnectorKeySchema,
  connectorType: mcpConnectorKeySchema,
  connectionId: discoveryBindingSchema.shape.connectionId,
});
const summary = {
  id: z.string().min(1).max(280),
  key: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  viaSkills: z.array(skillKey).max(DISCOVERY_LIMITS.sources).default([]),
  direct: z.boolean().default(true),
};
const definitions = {
  tools: z.array(mcpToolSchema).max(MCP_LIMITS.tools),
  resources: z.array(mcpResourceSchema).max(MCP_LIMITS.resources),
};
const sourceKind = z.enum(["resource", "connector"]);
export const nativeDiscoveryEntrySchema = z.union([
  z.strictObject({
    ...summary,
    kind: z.literal("resource"),
    status: z.literal("resolved"),
    route: nativeMcpRouteSchema,
    ...definitions,
  }),
  z.strictObject({
    ...summary,
    kind: z.literal("connector"),
    status: z.literal("resolved"),
    route: connectorMcpRouteSchema,
    whole: z.boolean(),
    selectors: z.array(z.string().min(1).max(280)).max(32),
    ...definitions,
  }),
  z.strictObject({
    ...summary,
    kind: z.literal("skill"),
    status: z.enum(["resolved", "incomplete"]),
    document: z.string().max(DISCOVERY_LIMITS.instructionBytes),
    dependencies: z.array(z.string().min(1).max(280)).max(8),
  }),
  z.strictObject({
    ...summary,
    kind: z.enum(["resource", "connector", "skill"]),
    status: z.literal("catalog"),
  }),
  z.strictObject({
    ...summary,
    kind: sourceKind,
    status: z.literal("selection_required"),
    catalogComplete: z.boolean(),
    choices: z
      .array(
        z.strictObject({
          connectorKey: mcpConnectorKeySchema,
          connectorName: z.string().max(200),
          connectionId: discoveryBindingSchema.shape.connectionId,
          name: z.string().max(200),
          accountName: z.string().max(500),
        }),
      )
      .max(200),
  }),
  z.strictObject({
    ...summary,
    kind: z.enum(["resource", "connector", "skill"]),
    status: z.literal("unavailable"),
    code: z.enum([
      "source_unavailable",
      "connection_required",
      "bound_connection_unavailable",
      "capacity",
      "cancelled",
      "unsupported",
      "incomplete_catalog",
    ]),
  }),
]);
export const nativeDiscoveryResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    issuer: z.url().max(2000),
    subject: z.string().min(1).max(256),
    results: z.array(nativeDiscoveryEntrySchema).max(DISCOVERY_LIMITS.entries),
    nextCursor: nativeDiscoveryRequestSchema.shape.cursor,
    resetRequired: z.literal("identity_changed").optional(),
    warnings: z
      .array(z.enum(["connector_catalog_unavailable", "skill_catalog_unavailable"]))
      .max(2)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.resetRequired && value.results.length)
      context.addIssue({
        code: "custom",
        message: "Identity reset cannot contain routable definitions",
      });
    const ids = new Set(value.results.map((entry) => entry.id));
    if (ids.size !== value.results.length)
      context.addIssue({ code: "custom", message: "Duplicate discovery identity" });
    for (const entry of value.results) {
      if (entry.status !== "resolved" || entry.kind === "skill") continue;
      const key = entry.kind === "resource" ? entry.route.resourceKey : entry.route.connectorKey;
      if (
        key !== entry.key ||
        entry.id !== `${entry.kind}:${key}` ||
        new Set(entry.tools.map((t) => t.name)).size !== entry.tools.length ||
        new Set(entry.resources.map((r) => r.uri)).size !== entry.resources.length
      )
        context.addIssue({
          code: "custom",
          message: "Invalid source routing or duplicate definitions",
        });
    }
    for (const entry of value.results) {
      if (
        entry.kind === "skill" &&
        (entry.status === "resolved" || entry.status === "incomplete") &&
        entry.dependencies.some((id) => !ids.has(id))
      )
        context.addIssue({ code: "custom", message: "Missing dependency outcome" });
    }
  });
export type NativeDiscoveryRequest = z.input<typeof nativeDiscoveryRequestSchema>;
export type NativeDiscoveryResponse = z.output<typeof nativeDiscoveryResponseSchema>;
export type DiscoveryEntry = NativeDiscoveryResponse["results"][number];
export type NativeMcpRoute = z.output<typeof nativeMcpRouteSchema>;
