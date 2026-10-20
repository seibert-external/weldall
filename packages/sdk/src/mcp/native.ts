import { z } from "zod";
import type { AuthContext } from "../types.js";
import {
  normalizeRequestTarget,
  requestPrefixAccepts,
  type ResourceRegistryEntry,
} from "../resource-registry.js";
import { MCP_LIMITS, mcpToolSchema, mcpResourceSchema } from "./contracts.js";

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

/** Metadata can describe only the endpoint and scopes within an authenticated registration. */
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

const operationMetadata = z.object({ "weldall/scopes": nativeMcpScopesSchema });
export const nativeMcpToolsSchema = z.object({
  tools: z.array(mcpToolSchema.extend({ _meta: operationMetadata })).max(MCP_LIMITS.tools),
});
export const nativeMcpResourcesSchema = z.object({
  resources: z
    .array(mcpResourceSchema.extend({ _meta: operationMetadata }))
    .max(MCP_LIMITS.resources),
});

/** Runtime is optional: only the /mcp/server entrypoint loads the MCP SDK. */
export interface NativeMcpProvider {
  readonly path: string;
  readonly discoveryScopes: readonly string[];
  readonly operationScopes: readonly string[];
  metadata(publicOrigin: string): NativeMcpMetadata;
  handle(request: Request, auth: AuthContext): Promise<Response>;
}
