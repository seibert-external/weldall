import { describe, expect, it } from "vitest";
import { connectorCapabilitiesSchema } from "../src/connectors.js";
import { mcpConnectorsSchema } from "../src/mcp/contracts.js";

describe("connector capabilities", () => {
  it("validates transport capabilities without interpreting provider names", () => {
    for (const capabilities of [[], ["http"], ["mcp"], ["http", "mcp"]])
      expect(connectorCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    for (const capabilities of [null, "mcp", ["mcp", "mcp"], ["unknown"], [1]])
      expect(connectorCapabilitiesSchema.safeParse(capabilities).success).toBe(false);
  });
  it("requires capabilities on the unshipped MCP catalog contract", () => {
    const connector = { key: "arbitrary-provider", name: "Work" };
    expect(mcpConnectorsSchema.safeParse([connector]).success).toBe(false);
    expect(mcpConnectorsSchema.parse([{ ...connector, capabilities: ["mcp"] }])).toEqual([
      { ...connector, capabilities: ["mcp"] },
    ]);
  });
});
