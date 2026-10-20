import { afterEach, describe, expect, it, vi } from "vitest";
import { Hash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpActivation } from "../src/activation.js";
import { createServer } from "../src/server.js";

const source = (key: string) => ({
  kind: "resource",
  id: `resource:${key}`,
  key,
  name: key,
  description: `Native ${key}`,
  status: "resolved",
  route: {
    resourceKey: key,
    resourceIdentifier: `https://${key}.example/api`,
    revision: "a".repeat(64),
  },
  tools: [
    {
      name: "read",
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://unreviewed" } },
    },
  ],
  resources: [{ uri: "fixture://text", name: "Text" }],
});
function fixture() {
  const state = {
    issuer: "https://weldall.example",
    subject: "alice",
    entries: [source("expenses")] as Record<string, unknown>[],
  };
  const cli = {
    nativeDiscoveryVersion: 1 as const,
    run: vi.fn(async (args: string[]) => {
      if (args[0] === "discover")
        return JSON.stringify({
          schemaVersion: 1,
          issuer: state.issuer,
          subject: state.subject,
          results: state.entries,
        });
      if (args[2] === "call") return JSON.stringify({ content: [{ type: "text", text: "ok" }] });
      if (args[2] === "read-resource")
        return JSON.stringify({ contents: [{ uri: "fixture://text", text: "ok" }] });
      throw new Error("Unexpected command");
    }),
  };
  const changed = { tools: vi.fn(async () => {}), resources: vi.fn(async () => {}) };
  return { cli, state, changed, activation: new McpActivation(cli, changed) };
}
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("native discovery publication", () => {
  it("publishes real handlers and notifications before the next list request", async () => {
    const { cli } = fixture();
    const server = createServer(cli, "test", "Follow the organization workflow.");
    const client = new Client({ name: "test", version: "1" });
    const [host, extension] = InMemoryTransport.createLinkedPair();
    closers.push(
      () => client.close(),
      () => server.close(),
    );
    const changed = vi.fn();
    client.setNotificationHandler(ToolListChangedNotificationSchema, changed);
    await server.connect(extension);
    await client.connect(host);
    expect((await client.listTools()).tools.some((t) => t.name === "discover_integrations")).toBe(
      true,
    );
    const outcome = await client.callTool({
      name: "discover_integrations",
      arguments: { resources: ["expenses"] },
    });
    expect(outcome).toMatchObject({ structuredContent: { results: [{ status: "active" }] } });
    const tool = (await client.listTools()).tools.find((t) => t.name.startsWith("native_"))!;
    expect(tool.name).toMatch(/^native_read_[a-f0-9]{12}$/);
    expect(`weldall__${tool.name}`.length).toBeLessThanOrEqual(64);
    expect(tool).not.toHaveProperty("_meta");
    expect(changed).toHaveBeenCalledOnce();
    expect(await client.callTool({ name: tool.name, arguments: {} })).toMatchObject({
      content: [{ text: "ok" }],
    });
    const argv = cli.run.mock.calls.find(([args]) => args[2] === "call")![0];
    expect(argv).toEqual(
      expect.arrayContaining([
        "mcp",
        "native",
        "call",
        "expenses",
        "read",
        "--expected-subject=alice",
        "--expected-issuer=https://weldall.example",
        `--expected-revision=${"a".repeat(64)}`,
        "--expected-resource-identifier=https://expenses.example/api",
      ]),
    );
    const resource = (await client.listResources()).resources[0]!;
    expect(await client.readResource({ uri: resource.uri })).toMatchObject({
      contents: [{ text: "ok", uri: resource.uri }],
    });
  });
  it("preserves independent successes and reports unavailable sources without partial tools", async () => {
    const { state, activation } = fixture();
    state.entries.push({
      kind: "resource",
      id: "resource:missing",
      key: "missing",
      name: "Missing",
      description: "",
      status: "unavailable",
      code: "source_unavailable",
    });
    const result = await activation.call("discover_integrations", {
      resources: ["expenses", "missing"],
    });
    expect(result).toMatchObject({
      structuredContent: { results: [{ status: "active" }, { status: "unavailable" }] },
    });
    expect(activation.listTools()).toHaveLength(2);
    expect(activation.listResources()).toHaveLength(1);
  });
  it("is idempotent and namespaces identical upstream names by source", async () => {
    const { state, changed, activation } = fixture();
    await activation.call("discover_integrations", { resources: ["expenses"] });
    await activation.call("discover_integrations", { resources: ["expenses"] });
    expect(changed.tools).toHaveBeenCalledOnce();
    state.entries = [source("billing")];
    await activation.call("discover_integrations", { resources: ["billing"] });
    const names = activation.listTools().map((t) => t.name);
    expect(new Set(names).size).toBe(3);
    expect(names.filter((name) => name.startsWith("native_"))).toEqual([
      expect.stringMatching(/^native_read_[a-f0-9]{12}$/),
      expect.stringMatching(/^native_read_[a-f0-9]{12}$/),
    ]);
    expect(activation.listResources()).toHaveLength(2);
  });
  it("keeps sanitized and truncated names distinct and dispatches the original tool names", async () => {
    const { state, activation, cli } = fixture();
    const upstreamNames = [
      "list.expenses",
      "list_expenses",
      `read_${"a".repeat(57)}_a`,
      `read_${"a".repeat(57)}_b`,
    ];
    state.entries = [
      {
        ...source("expenses"),
        tools: upstreamNames.map((name) => ({ name, inputSchema: { type: "object" } })),
      },
    ];
    await activation.call("discover_integrations", { resources: ["expenses"] });
    const tools = activation.listTools().filter((tool) => tool.name.startsWith("native_"));
    expect(tools).toHaveLength(upstreamNames.length);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(upstreamNames.length);
    for (const [index, tool] of tools.entries()) {
      const original = upstreamNames[index]!;
      const readable = `native_${original}`.replace(/\./g, "_").slice(0, 42);
      expect(tool.name.startsWith(`${readable}_`)).toBe(true);
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]+_[a-f0-9]{12}$/);
      expect(`weldall__${tool.name}`.length).toBeLessThanOrEqual(64);
      await activation.call(tool.name, {});
      expect(cli.run.mock.calls.at(-1)![0].slice(0, 5)).toEqual([
        "mcp",
        "native",
        "call",
        "expenses",
        original,
      ]);
    }
  });
  it("rejects a suffix collision without replacing an existing tool binding", async () => {
    const digest = vi.spyOn(Hash.prototype, "digest").mockReturnValue("a".repeat(64));
    try {
      const { state, activation, cli, changed } = fixture();
      await activation.call("discover_integrations", { resources: ["expenses"] });
      const tool = activation.listTools().find((entry) => entry.name.startsWith("native_"))!;
      state.entries = [source("billing")];
      expect(
        await activation.call("discover_integrations", { resources: ["billing"] }),
      ).toMatchObject({
        structuredContent: { results: [{ id: "resource:billing", status: "unavailable" }] },
      });
      expect(activation.listTools()).toHaveLength(2);
      expect(activation.listResources()).toHaveLength(1);
      expect(changed.tools).toHaveBeenCalledOnce();
      await activation.call(tool.name, {});
      expect(cli.run.mock.calls.at(-1)![0].slice(0, 5)).toEqual([
        "mcp",
        "native",
        "call",
        "expenses",
        "read",
      ]);
    } finally {
      digest.mockRestore();
    }
  });
  it("does not activate catalog-only results or accept missing/extra results", async () => {
    const { state, activation } = fixture();
    state.entries = [
      {
        kind: "resource",
        id: "resource:expenses",
        key: "expenses",
        name: "Expenses",
        description: "Expenses",
        status: "catalog",
      },
    ];
    await activation.call("discover_integrations", { resources: ["expenses"], catalogOnly: true });
    expect(activation.listTools()).toHaveLength(1);
    state.entries = [];
    await expect(
      activation.call("discover_integrations", { resources: ["expenses"] }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    state.entries = [source("unrequested")];
    await expect(
      activation.call("discover_integrations", { resources: ["expenses"] }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each(["issuer", "subject"] as const)(
    "invalidates old routes on %s change and never reconstructs names/URIs",
    async (field) => {
      const { state, activation, cli } = fixture();
      await activation.call("discover_integrations", { resources: ["expenses"] });
      const oldTool = activation.listTools().find((t) => t.name.startsWith("native_"))!.name;
      const oldUri = activation.listResources()[0]!.uri;
      state[field] = field === "issuer" ? "https://elsewhere.example" : "bob";
      await activation.call("discover_integrations", { resources: ["expenses"] });
      const requests = cli.run.mock.calls.length;
      await expect(activation.call(oldTool, {})).rejects.toMatchObject({ code: "invalid_request" });
      await expect(activation.read(oldUri)).rejects.toMatchObject({ code: "invalid_request" });
      expect(cli.run).toHaveBeenCalledTimes(requests);
      const fresh = new McpActivation(cli, { tools: async () => {}, resources: async () => {} });
      await expect(fresh.call(oldTool, {})).rejects.toThrow();
    },
  );
  it("does not resurrect an old identity's resource bindings from an in-flight result", async () => {
    const { state, activation, cli } = fixture();
    await activation.call("discover_integrations", { resources: ["expenses"] });
    const tool = activation.listTools().find((item) => item.name.startsWith("native_"))!.name;
    const priorUri = activation.listResources()[0]!.uri;
    const oldLinkedUri =
      priorUri.slice(0, priorUri.lastIndexOf("/") + 1) +
      Buffer.from("fixture://old-linked").toString("base64url");
    let finish!: (value: string) => void;
    cli.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = activation.call(tool, {});
    state.subject = "bob";
    await activation.call("discover_integrations", { resources: ["expenses"] });
    finish(
      JSON.stringify({
        content: [
          { type: "resource_link", name: "Old linked resource", uri: "fixture://old-linked" },
        ],
      }),
    );
    expect(await pending).toMatchObject({ content: [{ type: "resource_link" }] });
    expect(activation.listResources()).toHaveLength(1);
    const count = cli.run.mock.calls.length;
    await expect(activation.read(oldLinkedUri)).rejects.toMatchObject({ code: "invalid_request" });
    expect(cli.run).toHaveBeenCalledTimes(count);
  });
  it("does not expose discovery on a shipped CLI without explicit capability negotiation", () => {
    const activation = new McpActivation(
      { run: vi.fn() },
      { tools: async () => {}, resources: async () => {} },
    );
    expect(activation.hasTool("discover_integrations")).toBe(false);
    expect(activation.listTools()).toEqual([]);
  });
});
