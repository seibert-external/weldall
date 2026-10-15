import { z } from "zod";
import { ConnectorError } from "../../errors";

export const ATLASSIAN_MCP = Object.freeze({
  resource: "https://mcp.atlassian.com/v2/mcp",
  resourceMetadata: "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp",
  issuer: "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3",
  metadata:
    "https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3",
  authorization: "https://auth.atlassian.com/authorize",
  token: "https://auth.atlassian.com/oauth/token",
  registration: "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register",
});
import {
  ATLASSIAN_MCP_REQUIRED_SCOPES as requiredScopes,
  ATLASSIAN_MCP_SCOPES as scopeCatalog,
  atlassianMcpConfigSchema,
  canonicalScopes,
} from "@weldall/sdk/mcp";
export { requiredScopes, scopeCatalog, atlassianMcpConfigSchema, canonicalScopes };
export const selectionSchema = z.strictObject({
  scopes: z.array(z.string().max(120)).max(40).transform(canonicalScopes),
});
export function validateSelection(config: unknown, value: unknown) {
  const policy = atlassianMcpConfigSchema.parse(config);
  const selection = selectionSchema.parse(value);
  if (
    !requiredScopes.every((s) => selection.scopes.includes(s)) ||
    !selection.scopes.some((s) => policy.allowedScopes.some((allowed) => allowed === s)) ||
    selection.scopes.some(
      (s) => !requiredScopes.includes(s) && !policy.allowedScopes.some((allowed) => allowed === s),
    )
  )
    throw new ConnectorError("invalid_selection", "Select only offered MCP permissions.");
  return selection;
}
export function validateMcpEndpoint(endpoint: URL) {
  if (endpoint.href !== ATLASSIAN_MCP.resource)
    throw new ConnectorError(
      "invalid_target",
      "This connector supports only the reviewed Atlassian MCP endpoint.",
    );
}
