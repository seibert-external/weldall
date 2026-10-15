import { describe, expect, it, vi } from "vitest";
import { callTool, tools } from "../src/tools.js";

// Goose 1.51 Code Mode converts the entire advertised tool set to TypeScript before
// running any callback. Recursive z.json() definitions caused TS2456 in SendInputSchema0,
// blocking even list_skills. Keep the wire contract reference-free; this is a schema
// regression guard, not a substitute for testing Goose's own code generator.
describe("Goose Code Mode schema compatibility", () => {
  it.each(tools)("advertises $name without recursive definitions or references", (tool) => {
    const schema = JSON.stringify(tool.inputSchema);
    expect(schema).not.toContain('"$ref"');
    expect(schema).not.toContain('"$defs"');
  });

  it("keeps send arguments strict while advertising a generic optional JSON value", () => {
    const schema = tools.find((tool) => tool.name === "send")!.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("method");
    expect(schema.required).not.toContain("json");
    expect(schema.properties?.json).toEqual({ description: expect.stringContaining("JSON") });
    expect(schema.properties?.responseMode).toMatchObject({ enum: ["auto", "text"] });
  });

  it.each([
    { nested: { rows: [{ values: [null, true, 42, "text"] }] } },
    [{ nested: [false, { key: "value" }] }],
    null,
    "text",
    42,
    false,
  ])("still passes JSON bodies unchanged: %j", async (json) => {
    const cli = { run: vi.fn().mockResolvedValue('{"ok":true}') };
    const result = await callTool(cli, "send", {
      url: "https://example.com/api",
      scope: "write",
      method: "POST",
      json,
    });
    expect(result.isError).not.toBe(true);
    expect(cli.run).toHaveBeenCalledOnce();
    expect(cli.run.mock.calls[0]?.[0]).toContain(`--json=${JSON.stringify(json)}`);
  });

  it.each([
    { value: undefined },
    { value: NaN },
    { value: Infinity },
    { value: 1n },
    { value: () => "not JSON" },
    new Date("2026-01-01"),
  ])("rejects non-JSON runtime values before dispatch (case %#)", async (json) => {
    const cli = { run: vi.fn() };
    const result = await callTool(cli, "send", {
      url: "https://example.com/api",
      scope: "write",
      method: "POST",
      json,
    });
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
    expect(cli.run).not.toHaveBeenCalled();
  });
});
