import { z } from "zod";
import { mcpUriSchema } from "./contracts.js";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const mcpAppUriSchema = mcpUriSchema.refine((uri) => {
  try {
    const url = new URL(uri);
    return uri.startsWith("ui://") && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
});

/** No credentials, wildcard sources or executable URL schemes, even in local development. */
export const mcpAppAssetUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      /^[a-zA-Z0-9.:[\]_-]+$/.test(url.hostname) &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  });
export const mcpAppOriginSchema = mcpAppAssetUrlSchema.refine(
  (value) => URL.canParse(value) && new URL(value).origin === value,
);
export const mcpAppToolMetaSchema = z.object({
  ui: z.object({ resourceUri: mcpAppUriSchema }).optional(),
});
// Sandbox profile: forward only validated resource/connect origins, never frame domains,
// permissions or host-owned call handles.
export const mcpAppResourceMetaSchema = z.object({
  ui: z.object({
    csp: z
      .object({
        resourceDomains: z.array(mcpAppOriginSchema).max(16).default([]),
        connectDomains: z.array(mcpAppOriginSchema).max(16).default([]),
      })
      .optional(),
    prefersBorder: z.boolean().optional(),
  }),
});
