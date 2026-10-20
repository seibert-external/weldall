import { createHash } from "node:crypto";
import { mcpConnectorKeySchema, mcpToolNameSchema, mcpUriSchema } from "./contracts.js";

/** Dispatch still requires a session map. Never split this name to establish a binding. */
export function localMcpToolName(connectorKey: string, upstreamName: string) {
  const key = mcpConnectorKeySchema.parse(connectorKey);
  // Connector keys can contain separators and reach 120 characters; keep tool names bounded.
  const namespace = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `mcp_${namespace}__${mcpToolNameSchema.parse(upstreamName)}`;
}

/** Preserve the UI scheme so hosts recognize the app; authorization still uses session maps. */
export function localMcpAppResourceUri(namespace: string, upstreamUri: string) {
  return localMcpResourceUri(namespace, upstreamUri).replace(/^weldall-mcp:/, "ui:");
}

/** A display URI, not authorization. Only session-map entries may be read; never decode arbitrary input. */
export function localMcpResourceUri(connectorKey: string, upstreamUri: string) {
  return `weldall-mcp://${mcpConnectorKeySchema.parse(connectorKey)}/${Buffer.from(mcpUriSchema.parse(upstreamUri), "utf8").toString("base64url")}`;
}
