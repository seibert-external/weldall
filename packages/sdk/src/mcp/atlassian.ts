import { z } from "zod";

export const ATLASSIAN_MCP_REQUIRED_SCOPES = ["read:me", "read:account", "offline_access"];
export const ATLASSIAN_MCP_SCOPES = [
  "read:jira:agent-interface",
  "search:jira:agent-interface",
  "write:jira:agent-interface",
  "delete:jira:agent-interface",
  "manage:jira:agent-interface",
  "read:confluence:agent-interface",
  "search:confluence:agent-interface",
  "write:confluence:agent-interface",
] as const;
export const canonicalScopes = <T extends string>(scopes: T[]) => [...new Set(scopes)].sort();
const scopes = z.array(z.enum(ATLASSIAN_MCP_SCOPES)).max(32).transform(canonicalScopes);
export const atlassianMcpConfigSchema = z
  .strictObject({ allowedScopes: scopes, defaultScopes: scopes })
  .refine(
    (v) => v.allowedScopes.length > 0 && v.defaultScopes.every((s) => v.allowedScopes.includes(s)),
    "Default scopes must be allowed.",
  );
