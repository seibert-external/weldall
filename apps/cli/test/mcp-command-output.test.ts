import { cli, define } from "gunshi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoveryCommand } from "../src/discovery-command.js";
import { mcpCommand } from "../src/mcp-commands.js";
import { discoverNativeResources } from "../src/services/discovery.js";
import { requestNativeMcp } from "../src/services/native-mcp.js";
import { requestMcp } from "../src/services/mcp.js";

vi.mock("../src/config.js", () => ({ resolveWeldallConfig: vi.fn(async () => ({})) }));
vi.mock("../src/services/discovery.js", () => ({ discoverNativeResources: vi.fn() }));
vi.mock("../src/services/native-mcp.js", () => ({ requestNativeMcp: vi.fn() }));
vi.mock("../src/services/mcp.js", () => ({ requestMcp: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const run = (args: string[]) =>
  cli(args, define({ name: "weldall", run: () => undefined }), {
    name: "weldall",
    version: "0.0.0",
    subCommands: { discover: discoveryCommand, mcp: mcpCommand },
    renderValidationErrors: null,
    renderHeader: () => "",
  });

const discovery = {
  schemaVersion: 1 as const,
  issuer: "https://weldall.example",
  subject: "alice",
  results: [],
  warnings: [],
};
const result = { content: [{ type: "text" as const, text: "First\nSecond\u001b[2J\u0085" }] };

describe.each([false, true])("MCP output (json=%s)", (json) => {
  it.each([
    ["discover", "--query", "food"],
    ["mcp", "native", "call", "expenses", "read"],
    ["mcp", "call", "work", "read", "--connection=mine"],
  ])("preserves JSON layout for %s %s", async (...args) => {
    vi.mocked(discoverNativeResources).mockResolvedValue(discovery);
    vi.mocked(requestNativeMcp).mockResolvedValue(result);
    vi.mocked(requestMcp).mockResolvedValue(result);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await run([...args, ...(json ? ["--json"] : [])]);
    const expected = JSON.stringify(args[0] === "discover" ? discovery : result, null, 2);
    expect(output).toHaveBeenCalledExactlyOnceWith(
      json ? expected : expected.replace(/\u0085/g, "�"),
    );
    expect(output.mock.calls[0]![0]).toContain("\n");
  });
});

it.each(["list", "tools", "resources"] as const)(
  "preserves MCP %s column separators while sanitizing individual fields",
  async (operation) => {
    const name = "Name\n\u001b[2J";
    vi.mocked(requestMcp).mockResolvedValue(
      operation === "list"
        ? [{ key: "work", name, capabilities: ["mcp"] }]
        : operation === "tools"
          ? { tools: [{ name: "read", description: name, inputSchema: { type: "object" } }] }
          : { resources: [{ uri: "fixture://current", name }] },
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await run(["mcp", operation, ...(operation === "list" ? [] : ["work", "--connection=mine"])]);
    const key =
      operation === "list" ? "work" : operation === "tools" ? "read" : "fixture://current";
    expect(output).toHaveBeenCalledExactlyOnceWith(`${key}\tName��[2J`);
  },
);

it.each(["tools", "resources"] as const)(
  "passes identity guards to MCP %s selection",
  async (operation) => {
    vi.mocked(requestMcp).mockResolvedValue(
      operation === "tools"
        ? { tools: [{ name: "read", inputSchema: { type: "object" } }] }
        : { resources: [{ uri: "fixture://current", name: "Current" }] },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await run([
      "mcp",
      operation,
      "work",
      "--connection=mine",
      "--expected-issuer=https://weldall.example",
      "--expected-subject=alice",
    ]);
    expect(requestMcp).toHaveBeenCalledWith(
      {},
      operation,
      {
        connectorKey: "work",
        connection: "mine",
        expectedIssuer: "https://weldall.example",
        expectedSubject: "alice",
      },
      expect.any(AbortSignal),
    );
  },
);
