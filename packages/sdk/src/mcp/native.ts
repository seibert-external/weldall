import { z } from "zod";
import type { AuthContext } from "../types.js";
import {
  normalizeRequestTarget,
  requestPrefixAccepts,
  type ResourceRegistryEntry,
} from "../resource-registry.js";
import { MCP_LIMITS, mcpToolSchema, mcpResourceSchema, mcpReadResultSchema } from "./contracts.js";
import { mcpAppToolMetaSchema, mcpAppResourceMetaSchema } from "./apps.js";

export const nativeMcpScopesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(160)
      .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/),
  )
  .min(1)
  .max(100)
  .refine((scopes) => new Set(scopes).size === scopes.length)
  .meta({ uniqueItems: true });

export const nativeMcpMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transport: z.literal("streamable-http-stateless"),
  endpoint: z.url().max(2000),
  description: z.string().min(1).max(2000),
  discoveryScopes: nativeMcpScopesSchema,
  capabilities: z.tuple([z.literal("tools"), z.literal("resources")]),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

export type NativeMcpMetadata = z.output<typeof nativeMcpMetadataSchema>;

/**
 * Validate a native MCP advertisement against the authenticated resource registration.
 * @param resource Trusted registry entry defining the resource identity, issuer, prefixes and scopes.
 * @param document Untrusted protected-resource metadata fetched from the resource service.
 * @returns Validated native MCP metadata, including the endpoint and catalog revision.
 * @throws If the document is malformed or advertises an endpoint/policy outside that registration.
 */
export function validateNativeMcpMetadata(
  resource: Omit<ResourceRegistryEntry, "grantedScopes">,
  document: unknown,
): NativeMcpMetadata {
  const value = z
    .object({
      resource: z.literal(resource.resourceIdentifier),
      authorization_servers: z.array(z.string()),
      weldall_mcp: nativeMcpMetadataSchema,
    })
    .parse(document);
  const metadata = value.weldall_mcp;
  const endpoint = normalizeRequestTarget(metadata.endpoint);
  if (
    !value.authorization_servers.includes(resource.authorizationServer) ||
    endpoint.search ||
    endpoint.origin !== resource.authorizationServer ||
    !resource.requestPrefixes.some((prefix) => requestPrefixAccepts(prefix, endpoint)) ||
    metadata.discoveryScopes.some((scope) => !resource.supportedScopes.includes(scope))
  )
    throw new TypeError("Native MCP endpoint or policy is outside the trusted registration");
  return metadata;
}

export const nativeMcpToolDefinitionSchema = mcpToolSchema.extend({
  _meta: mcpAppToolMetaSchema.optional(),
});
const operationMetadata = z.object({ "weldall/scopes": nativeMcpScopesSchema });
export const nativeMcpToolsSchema = z.object({
  tools: z
    .array(
      mcpToolSchema.extend({
        _meta: operationMetadata.extend({ ui: mcpAppToolMetaSchema.shape.ui.optional() }),
      }),
    )
    .max(MCP_LIMITS.tools),
});
const [textResource, blobResource] = mcpReadResultSchema.shape.contents.element.options;
export const nativeMcpReadResultSchema = z.object({
  contents: z
    .array(
      z.union([
        textResource.extend({ _meta: mcpAppResourceMetaSchema.optional() }),
        blobResource.extend({ _meta: mcpAppResourceMetaSchema.optional() }),
      ]),
    )
    .max(100),
});
export const nativeMcpResourcesSchema = z.object({
  resources: z
    .array(mcpResourceSchema.extend({ _meta: operationMetadata }))
    .max(MCP_LIMITS.resources),
});

/** Provider consumed by Weldall HTTP adapters; create it with `createNativeMcp` from `/mcp/server`. */
export interface NativeMcpProvider {
  /** Mounted POST route, e.g. `/api/mcp`. */
  readonly path: string;
  /** Scopes ALL required for discovery and every subsequent operation. */
  readonly discoveryScopes: readonly string[];
  /** Union of scopes declared by all tools and resources; not a caller's granted scopes. */
  readonly operationScopes: readonly string[];
  /**
   * Build the advertisement included in protected-resource metadata.
   * @param publicOrigin Externally reachable service origin used to resolve the MCP route.
   */
  metadata(publicOrigin: string): NativeMcpMetadata;
  /**
   * Handle one stateless request after authentication by a Weldall HTTP adapter.
   * @param request Incoming MCP HTTP request, including its cancellation signal.
   * @param auth Already verified caller context; this method does not authenticate bearer tokens itself.
   * @returns MCP HTTP response. Prefer the adapter's MCP handler over calling this method directly.
   */
  handle(request: Request, auth: AuthContext): Promise<Response>;
}
