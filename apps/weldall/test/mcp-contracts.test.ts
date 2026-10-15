import { describe, expect, it } from "vitest";
import {
  assertMcpJson,
  MCP_LIMITS,
  mcpCallResultSchema,
  mcpReadResultSchema,
  mcpResourcesPageSchema,
  mcpToolsPageSchema,
  parseMcpResponse,
  skillMcpDependenciesSchema,
} from "@weldall/sdk/mcp";
import { McpBoundaryError } from "@weldall/sdk/mcp";
import { localMcpResourceUri, localMcpToolName } from "@weldall/sdk/mcp";
import { fixtureResources, fixtureTools } from "./fixtures/mcp-server";

const dependency = {
  connectorKey: "atlassian",
  tools: ["getConfluenceContent"],
  includeResources: false,
};

describe("bounded MCP contracts", () => {
  it("normalizes skill dependencies deterministically without mutating input", () => {
    const input = [
      { ...dependency, tools: ["z.read", "a.read", "z.read"] },
      { connectorKey: "another", tools: [], includeResources: true },
    ];
    expect(skillMcpDependenciesSchema.parse(input)).toEqual([
      { connectorKey: "another", tools: [], includeResources: true },
      { ...dependency, tools: ["a.read", "z.read"] },
    ]);
    expect(input[0]!.tools).toEqual(["z.read", "a.read", "z.read"]);
    expect(skillMcpDependenciesSchema.parse([])).toEqual([]);
  });

  it.each(["connection", "connectionId", "credentials", "headers", "scopes", "endpointUrl"])(
    "rejects forbidden skill field %s",
    (field) => {
      expect(
        skillMcpDependenciesSchema.safeParse([{ ...dependency, [field]: "not-authority" }]).success,
      ).toBe(false);
    },
  );

  it.each([
    null,
    {},
    [{ ...dependency, tools: [] }],
    [{ ...dependency, includeResources: "false" }],
    [{ ...dependency, tools: ["wildcard*"] }],
    [{ ...dependency, connectorKey: "bad/key" }],
    [dependency, dependency],
    [{ ...dependency, tools: Array.from({ length: 33 }, (_, index) => `tool${index}`) }],
    Array.from({ length: 9 }, (_, index) => ({ ...dependency, connectorKey: `server-${index}` })),
  ])("fails closed on malformed persisted dependencies %#", (value) => {
    expect(skillMcpDependenciesSchema.safeParse(value).success).toBe(false);
  });

  it("uses collision-safe bounded tool names without treating them as dispatch authority", () => {
    expect(localMcpToolName("atlassian", "getConfluenceContent")).toMatch(
      /^mcp_[a-f0-9]{32}__getConfluenceContent$/,
    );
    expect(localMcpToolName("a".repeat(120), "t".repeat(64)).length).toBeLessThanOrEqual(128);
    expect(localMcpToolName("a__b", "read")).not.toBe(localMcpToolName("a", "b__read"));
    for (const connector of ["a__b", "a.b-c", "0", "a-", "a".repeat(120)])
      expect(() => localMcpToolName(connector, "read")).not.toThrow();
    for (const connector of ["A", "a/b", "-a", "a".repeat(121)])
      expect(() => localMcpToolName(connector, "read")).toThrow();
    for (const tool of ["", "a/b", "--read?", "a".repeat(65), "read\n"])
      expect(() => localMcpToolName("atlassian", tool)).toThrow();
  });

  it("encodes opaque upstream resource URIs without path or namespace collisions", () => {
    const uri = "fixture:///report.txt?part=ä#one";
    expect(localMcpResourceUri("atlassian", uri)).toBe(
      `weldall-mcp://atlassian/${Buffer.from(uri).toString("base64url")}`,
    );
    expect(localMcpResourceUri("a", uri)).not.toBe(localMcpResourceUri("b", uri));
    for (const invalid of [
      "no-scheme",
      "https://example.com/\n",
      "file:///" + "x".repeat(MCP_LIMITS.uriBytes),
    ])
      expect(() => localMcpResourceUri("atlassian", invalid)).toThrow();
  });

  it("projects only the supported metadata and drops MCP Apps", () => {
    expect(
      parseMcpResponse(mcpToolsPageSchema, {
        tools: [
          {
            ...fixtureTools[0],
            _meta: { ui: { resourceUri: "ui://secret-app" } },
            icons: [{ src: "https://untrusted.invalid/icon" }],
          },
        ],
        _meta: { diagnostic: "not-forwarded" },
      }),
    ).toEqual({ tools: [fixtureTools[0]] });
    expect(
      parseMcpResponse(mcpResourcesPageSchema, {
        resources: [{ ...fixtureResources[0], _meta: { token: "not-forwarded" } }],
      }),
    ).toEqual({ resources: [fixtureResources[0]] });
  });

  it.each([
    { tools: "bad" },
    { tools: [{ ...fixtureTools[0], name: "bad/tool" }] },
    { tools: [{ ...fixtureTools[0], inputSchema: { type: "array" } }] },
    { tools: fixtureTools, nextCursor: "" },
    { tools: fixtureTools, nextCursor: "x".repeat(MCP_LIMITS.cursorBytes + 1) },
    { tools: Array.from({ length: MCP_LIMITS.tools + 1 }, () => fixtureTools[0]) },
    { tools: [{ ...fixtureTools[0], description: "ü".repeat(MCP_LIMITS.descriptionBytes) }] },
  ])("rejects invalid or excessive definitions %# with a fixed local error", (value) => {
    expect(() => parseMcpResponse(mcpToolsPageSchema, value)).toThrow(McpBoundaryError);
    try {
      parseMcpResponse(mcpToolsPageSchema, value);
    } catch (error) {
      expect(String(error)).not.toContain("inputSchema");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("enforces byte budgets before discarding unknown metadata", () => {
    expect(() =>
      parseMcpResponse(mcpToolsPageSchema, { tools: [], _meta: { ignored: "x".repeat(100) } }, 50),
    ).toThrow(McpBoundaryError);
    expect(() => assertMcpJson({ text: "ü".repeat(25) }, 50)).toThrow(McpBoundaryError);
    expect(() => assertMcpJson({ text: "\\".repeat(30) }, 50)).toThrow(McpBoundaryError);
  });

  it("rejects deep, huge, cyclic, prototype-bearing and non-JSON data before recursive schema validation", () => {
    let deep: unknown = {};
    for (let index = 0; index < 20; index++) deep = { value: deep };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      deep,
      cyclic,
      BigInt(1),
      undefined,
      NaN,
      Infinity,
      new Date(),
      new Map(),
      JSON.parse('{"__proto__":{"polluted":true}}'),
      Array.from({ length: MCP_LIMITS.jsonNodes + 1 }, () => null),
    ])
      expect(() => assertMcpJson(value)).toThrow(McpBoundaryError);
    expect(() => assertMcpJson({ text: "hello", values: [null, true, 123] })).not.toThrow();
  });

  it("preserves bounded text, image, audio, resource-link, embedded-resource and structured results", () => {
    const result = {
      content: [
        { type: "text", text: "Hello" },
        { type: "image", data: "AAE=", mimeType: "image/png" },
        { type: "audio", data: "AAE=", mimeType: "audio/wav" },
        { type: "resource_link", ...fixtureResources[0] },
        { type: "resource", resource: { uri: "fixture:///text", text: "Hello" } },
      ],
      structuredContent: { records: [1, 2] },
      isError: false,
    };
    expect(parseMcpResponse(mcpCallResultSchema, result)).toEqual(result);
  });

  it.each([
    { content: [{ type: "ui", resourceUri: "ui://app" }] },
    { content: [{ type: "text", text: 42 }] },
    { content: [], isError: "false" },
    { content: [], structuredContent: [] },
    { content: [{ type: "audio", mimeType: "audio/wav", data: "not base64" }] },
  ])("rejects malformed or unsupported tool content %#", (value) => {
    expect(() => parseMcpResponse(mcpCallResultSchema, value)).toThrow(McpBoundaryError);
  });

  it.each([
    { uri: "fixture:///text", text: 42 },
    { uri: "fixture:///text", text: "Hello", blob: "AAE=" },
    { uri: "fixture:///text", blob: "AAE" },
    { uri: "fixture:///text", blob: "AB==" },
    { uri: "fixture:///text", blob: "%%%%" },
  ])("rejects ambiguous or malformed resource content %#", (value) => {
    expect(() => parseMcpResponse(mcpReadResultSchema, { contents: [value] })).toThrow(
      McpBoundaryError,
    );
  });
});
