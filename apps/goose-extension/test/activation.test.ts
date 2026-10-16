import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { localMcpResourceUri, localMcpToolName } from "@weldall/sdk/mcp";
import { McpActivation } from "../src/activation.js";
import { createServer } from "../src/server.js";
import { callTool } from "../src/tools.js";

const dependency = { connectorKey: "work", tools: ["read"], includeResources: true };
const account = {
  id: "connection-1",
  name: "work-account",
  accountName: "Site A",
  connectorKey: "work",
  connectorEnabled: true,
  capabilities: ["mcp"],
  status: "READY",
  details: [{ label: "MCP site", value: "site-a" }],
};
function fixture() {
  const state = {
    connections: [{ ...account }],
    connectors: [{ key: account.connectorKey, name: "Work", capabilities: ["mcp"] }],
    tools: ["read", "write"].map((name) => ({ name, inputSchema: { type: "object" } })),
    resources: [{ uri: "fixture:///text", name: "Text" }],
    result: {
      content: [
        { type: "resource_link", uri: "fixture:///linked", name: "Linked" },
        { type: "resource", resource: { uri: "fixture:///embedded", text: "embedded" } },
      ],
      structuredContent: { complete: true },
      isError: true,
    },
    dependencies: [dependency],
  };
  const cli = {
    run: vi.fn(async (args: string[]) => {
      if (args[0] === "connections") return JSON.stringify(state.connections);
      if (args[0] === "skills")
        return JSON.stringify({
          slug: "review",
          title: "Review",
          preview: "Review",
          available: true,
          missingScopes: [],
          requiredScopes: [],
          source: { type: "admin" },
          involvedResources: [],
          document: "# Review",
          mcpDependencies: state.dependencies,
        });
      switch (args[1]) {
        case "list":
          return JSON.stringify(state.connectors);
        case "tools":
          return JSON.stringify({ tools: state.tools });
        case "resources":
          return JSON.stringify({ resources: state.resources });
        case "call":
          return JSON.stringify(state.result);
        case "read-resource":
          return JSON.stringify({
            contents: [{ uri: args.find((a) => a.startsWith("--uri="))!.slice(6), blob: "AAE=" }],
          });
        default:
          throw new Error("Unexpected CLI command");
      }
    }),
  };
  const changed = { tools: vi.fn(async () => {}), resources: vi.fn(async () => {}) };
  return { state, cli, changed, activation: new McpActivation(cli, changed) };
}
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("session-local MCP activation", () => {
  it("activates only declared tools, namespaces resources and binds the unique READY account", async () => {
    const { activation, cli, changed } = fixture();
    await expect(activation.activate([dependency])).resolves.toEqual([
      { connectorKey: "work", status: "active" },
    ]);
    expect(activation.listTools().map((t) => t.name)).toEqual([localMcpToolName("work", "read")]);
    expect(activation.listResources()[0]?.uri).toBe(localMcpResourceUri("work", "fixture:///text"));
    expect(cli.run.mock.calls.filter(([args]) => args[1] === "tools")[0]?.[0]).toContain(
      "--connection=connection-1",
    );
    expect(changed.tools).toHaveBeenCalledOnce();
    expect(changed.resources).toHaveBeenCalledOnce();
  });
  it("uses capabilities rather than provider names to activate a connector", async () => {
    const { activation, state } = fixture();
    state.connectors[0]!.name = "HTTP-looking name";
    await expect(activation.activate([dependency])).resolves.toMatchObject([{ status: "active" }]);
  });
  it("rejects a non-MCP connector even when its name claims MCP support", async () => {
    const { activation, state, cli } = fixture();
    state.connectors[0]!.name = "Atlassian MCP";
    state.connectors[0]!.capabilities = ["http"];
    await expect(activation.activate([dependency])).rejects.toMatchObject({
      code: "mcp_unavailable",
    });
    expect(cli.run.mock.calls.some(([args]) => args[1] === "tools")).toBe(false);
  });
  it("does not choose a connection without MCP capability", async () => {
    const { activation, state, cli } = fixture();
    state.connections[0] = { ...account, capabilities: ["http"] };
    await expect(activation.activate([dependency])).resolves.toMatchObject([
      { status: "connection_required" },
    ]);
    expect(cli.run.mock.calls.some(([args]) => args[1] === "tools")).toBe(false);
  });
  it.each(["connectors", "connections"] as const)(
    "rejects prototype %s without capability metadata",
    async (field) => {
      const { activation, state } = fixture();
      Reflect.deleteProperty(state[field][0]!, "capabilities");
      await expect(activation.activate([dependency])).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );
  it("keeps session activation monotonic and repeated loads idempotent", async () => {
    const { activation, changed } = fixture();
    await activation.activate([dependency]);
    await activation.activate([dependency]);
    expect(changed.tools).toHaveBeenCalledOnce();
    await activation.activate([{ ...dependency, tools: ["write"], includeResources: false }]);
    expect(activation.listTools()).toHaveLength(2);
    expect(activation.listResources()).toHaveLength(1);
  });
  it("merges simultaneous skill loads without lost updates", async () => {
    const { activation } = fixture();
    await Promise.all([
      activation.activate([dependency]),
      activation.activate([{ ...dependency, tools: ["write"] }]),
    ]);
    expect(activation.listTools()).toHaveLength(2);
  });
  it.each([0, 2])("does not silently choose among %i READY connections", async (count) => {
    const { activation, state, cli } = fixture();
    state.connections = Array.from({ length: count }, (_, index) => ({
      ...account,
      id: `connection-${index}`,
      name: `account-${index}`,
    }));
    const status = await activation.activate([dependency]);
    expect(status[0]?.status).toBe(count ? "selection_required" : "connection_required");
    expect(activation.listTools().map((t) => t.name)).toEqual(["select_mcp_connection"]);
    expect(cli.run.mock.calls.some(([args]) => args[1] === "tools")).toBe(false);
  });
  it("requires explicit selection across personal/shared candidates and dispatches the selected ID", async () => {
    const { activation, state, cli } = fixture();
    state.connections = [
      Object.assign({ ...account }, { accessMode: "OWNER_ONLY", key: null }),
      Object.assign(
        { ...account, id: "shared-id", name: "Production bot" },
        { accessMode: "SCOPED", key: "production-bot", useScopes: ["jira:shared"] },
      ),
    ];
    expect(await activation.activate([dependency])).toMatchObject([
      { status: "selection_required" },
    ]);
    expect(cli.run.mock.calls.some(([args]) => args[1] === "tools")).toBe(false);
    await activation.call("select_mcp_connection", {
      connectorKey: "work",
      connection: "shared-id",
    });
    await activation.call(localMcpToolName("work", "read"), {});
    expect(
      cli.run.mock.calls.some(
        ([args]) => args[1] === "call" && args.includes("--connection=shared-id"),
      ),
    ).toBe(true);
  });
  it.each(["production", "Production bot 🌐"])(
    "offers IDs for duplicate labels %s and rejects ambiguous names",
    async (name) => {
      const { activation, state, cli } = fixture();
      state.connections = [
        { ...account, id: "bot-a", name, accountName: "Site A" },
        { ...account, id: "bot-b", name, accountName: "Site B" },
      ];
      const statuses = await activation.activate([dependency]);
      expect(statuses).toMatchObject([
        {
          status: "selection_required",
          choices: [
            { id: "bot-a", name, accountName: "Site A" },
            { id: "bot-b", name, accountName: "Site B" },
          ],
        },
      ]);
      await expect(
        activation.call("select_mcp_connection", { connectorKey: "work", connection: name }),
      ).rejects.toMatchObject({
        code: name === "production" ? "mcp_selection" : "invalid_request",
      });
      expect(cli.run.mock.calls.some(([args]) => args[1] === "tools")).toBe(false);
      await activation.call("select_mcp_connection", { connectorKey: "work", connection: "bot-b" });
      await activation.call(localMcpToolName("work", "read"), {});
      expect(
        cli.run.mock.calls.some(
          ([args]) => args[1] === "call" && args.includes("--connection=bot-b"),
        ),
      ).toBe(true);
    },
  );
  it("does not infer uniqueness from the shipped catalog at its truncation limit", async () => {
    const { activation, state } = fixture();
    state.connections.push(
      ...Array.from({ length: 199 }, (_, index) => ({
        ...account,
        id: `other-${index}`,
        name: `other-${index}`,
        connectorKey: "other",
      })),
    );
    expect(await activation.activate([dependency])).toMatchObject([
      { status: "selection_required", catalogComplete: false },
    ]);
    await activation.call("select_mcp_connection", {
      connectorKey: "work",
      connection: account.name,
    });
    expect(activation.hasTool(localMcpToolName("work", "read"))).toBe(true);
  });
  it("selection retains the pending skill's tools and rejects model-supplied replacements", async () => {
    const { activation, state } = fixture();
    state.connections.push({ ...account, id: "connection-2", name: "personal" });
    await activation.activate([dependency]);
    await expect(
      activation.call("select_mcp_connection", {
        connectorKey: "work",
        connection: "personal",
        tools: ["write"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await activation.call("select_mcp_connection", {
      connectorKey: "work",
      connection: "personal",
    });
    expect(activation.listTools().map((t) => t.name)).toEqual([localMcpToolName("work", "read")]);
    await expect(
      activation.call("select_mcp_connection", { connectorKey: "work", connection: account.name }),
    ).rejects.toMatchObject({ code: "mcp_rebind" });
  });
  it("rechecks candidates during selection and does not bind an account which stopped being READY", async () => {
    const { activation, state } = fixture();
    state.connections.push({ ...account, id: "connection-2", name: "personal" });
    await activation.activate([dependency]);
    state.connections[1]!.status = "RECONNECT_REQUIRED";
    await expect(
      activation.call("select_mcp_connection", { connectorKey: "work", connection: "personal" }),
    ).rejects.toMatchObject({ code: "mcp_selection" });
    expect(activation.listTools()).toHaveLength(1);
  });
  it("does not partially publish failed discovery", async () => {
    const { activation, state, changed } = fixture();
    state.tools = [];
    await expect(activation.activate([dependency])).rejects.toMatchObject({
      code: "mcp_unavailable",
    });
    expect(activation.listTools()).toEqual([]);
    expect(changed.tools).not.toHaveBeenCalled();
  });
  it("preserves structured content and business errors while rewriting embedded and linked resource URIs", async () => {
    const { activation, cli } = fixture();
    await activation.activate([{ ...dependency, includeResources: false }]);
    const output = await activation.call(localMcpToolName("work", "read"), {
      text: "--connection=evil; $(command)",
    });
    expect(output).toMatchObject({ structuredContent: { complete: true }, isError: true });
    expect(output.content[0]).toMatchObject({
      uri: localMcpResourceUri("work", "fixture:///linked"),
    });
    expect(output.content[1]).toMatchObject({
      resource: { uri: localMcpResourceUri("work", "fixture:///embedded") },
    });
    expect(activation.listResources()).toEqual([]);
    const read = await activation.read(localMcpResourceUri("work", "fixture:///linked"));
    expect(read.contents[0]).toMatchObject({
      blob: "AAE=",
      uri: localMcpResourceUri("work", "fixture:///linked"),
    });
    expect(cli.run.mock.calls.at(-1)?.[0]).toContain("--uri=fixture:///linked");
  });
  it("rejects forged names and URIs without dispatch and never retries failed calls", async () => {
    const { activation, cli } = fixture();
    await activation.activate([dependency]);
    const before = cli.run.mock.calls.length;
    await expect(activation.call(localMcpToolName("work", "write"), {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      activation.read(localMcpResourceUri("work", "fixture:///unseen")),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(cli.run).toHaveBeenCalledTimes(before);
    cli.run.mockRejectedValueOnce(new Error("ambiguous result"));
    await expect(activation.call(localMcpToolName("work", "read"), {})).rejects.toThrow();
    expect(cli.run).toHaveBeenCalledTimes(before + 1);
  });
  it("does not auto-rebind after a previously selected connection disappears", async () => {
    const { activation, state } = fixture();
    await activation.activate([dependency]);
    state.connections = [{ ...account, id: "replacement" }];
    await expect(activation.activate([dependency])).rejects.toMatchObject({
      code: "mcp_unavailable",
    });
  });
  it("fails closed on malformed persisted skill dependencies", async () => {
    const { cli } = fixture();
    cli.run.mockResolvedValueOnce(
      JSON.stringify({
        slug: "review",
        title: "Review",
        preview: "Review",
        available: true,
        missingScopes: [],
        source: { type: "admin" },
        document: "# Review",
        requiredScopes: [],
        involvedResources: [],
        mcpDependencies: [{ ...dependency, tools: "read" }],
      }),
    );
    const activate = vi.fn();
    expect(
      await callTool(cli, "read_skill_document", { slug: "review" }, undefined, activate),
    ).toMatchObject({ isError: true });
    expect(activate).not.toHaveBeenCalled();
  });
  it("publishes list-changed notifications and resources through the actual MCP server", async () => {
    const { cli } = fixture();
    const server = createServer(cli, "1.0.0", "");
    const client = new Client(
      { name: "stock-protocol-client", version: "1" },
      { capabilities: {} },
    );
    const toolsChanged = vi.fn(),
      resourcesChanged = vi.fn();
    client.setNotificationHandler(ToolListChangedNotificationSchema, toolsChanged);
    client.setNotificationHandler(ResourceListChangedNotificationSchema, resourcesChanged);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    expect((await client.listTools()).tools).toHaveLength(6);
    const loaded = await client.callTool({
      name: "read_skill_document",
      arguments: { slug: "review" },
    });
    expect(loaded.isError).not.toBe(true);
    expect(toolsChanged).toHaveBeenCalledOnce();
    expect(resourcesChanged).toHaveBeenCalledOnce();
    expect((await client.listTools()).tools).toHaveLength(7);
    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(1);
    expect(
      (await client.readResource({ uri: resources.resources[0]!.uri })).contents[0],
    ).toMatchObject({ blob: "AAE=" });
  });
});
