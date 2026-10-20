import { z } from "zod";
import { format } from "prettier";
import { readFileSync, writeFileSync } from "node:fs";
import {
  MCP_LIMITS,
  mcpConnectorsSchema,
  mcpConnectionsSchema,
  mcpToolsResponseSchema,
  mcpResourcesResponseSchema,
  mcpCallResultSchema,
  mcpReadResultSchema,
  mcpConnectionSelectionSchema,
  mcpToolCallSchema,
  mcpResourceReadSchema,
} from "../src/mcp/contracts.js";

import {
  nativeMcpMetadataSchema,
  nativeMcpScopesSchema,
  nativeMcpToolsSchema,
  nativeMcpResourcesSchema,
} from "../src/mcp/native.js";
import {
  nativeDiscoveryRequestSchema,
  nativeDiscoveryResponseSchema,
} from "../src/mcp/discovery.js";

// JSON Schema carries structural contracts; byte/depth/URI/base64 checks are enforced by both clients.
const schemas = {
  nativeMetadata: nativeMcpMetadataSchema,
  nativeScopes: nativeMcpScopesSchema,
  nativeTools: nativeMcpToolsSchema,
  nativeResources: nativeMcpResourcesSchema,
  nativeDiscoveryRequest: nativeDiscoveryRequestSchema,
  nativeDiscoveryResponse: nativeDiscoveryResponseSchema,
  connectors: mcpConnectorsSchema,
  connections: mcpConnectionsSchema,
  tools: mcpToolsResponseSchema,
  resources: mcpResourcesResponseSchema,
  call: mcpCallResultSchema,
  "read-resource": mcpReadResultSchema,
  selection: mcpConnectionSelectionSchema,
  toolCall: mcpToolCallSchema,
  resourceRead: mcpResourceReadSchema,
};
const serialized =
  JSON.stringify(
    {
      limits: MCP_LIMITS,
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([name, schema]) => [
          name,
          z.toJSONSchema(schema, { io: "input" }),
        ]),
      ),
    },
    null,
    2,
  ) + "\n";
const path = new URL("../../python-sdk/src/weldall/mcp-contracts.json", import.meta.url);
const output = await format(serialized, { parser: "json", printWidth: 100 });
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== output)
    throw new Error(
      "Regenerate Python MCP contracts with pnpm --filter @weldall/sdk exec tsx scripts/export-mcp-contracts.ts",
    );
} else writeFileSync(path, output);
