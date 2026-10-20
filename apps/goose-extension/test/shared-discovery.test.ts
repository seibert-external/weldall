import { describe, expect, it, vi } from "vitest";
import { McpActivation } from "../src/activation.js";
import { nativeDiscoveryRequestSchema } from "@weldall/sdk/mcp";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const connector = () => ({
  id: "connector:work",
  kind: "connector",
  key: "work",
  name: "Work",
  description: "Jira",
  status: "resolved",
  whole: true,
  selectors: ["connector-type:atlassian-mcp"],
  route: { connectorKey: "work", connectorType: "atlassian-mcp", connectionId: "alice-work" },
  tools: [{ name: "read", inputSchema: { type: "object" } }],
  resources: [{ name: "Current", uri: "jira://current" }],
});
const skill = () => ({
  id: "skill:review",
  kind: "skill",
  key: "review",
  name: "Review",
  description: "Review Jira",
  status: "resolved",
  document: "Use the review tools. Never retry a write.",
  dependencies: ["connector:work"],
});
function fixture() {
  const entries: Record<string, unknown>[] = [connector(), skill()];
  const cli = {
    nativeDiscoveryVersion: 1 as const,
    run: vi.fn(async (args: string[]) =>
      args[0] === "discover"
        ? JSON.stringify({
            schemaVersion: 1,
            issuer: "https://weldall.example",
            subject: "alice",
            results: entries,
          })
        : JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
    ),
  };
  const changed = { tools: vi.fn(async () => {}), resources: vi.fn(async () => {}) };
  return { cli, entries, changed, activation: new McpActivation(cli, changed) };
}

describe("shared CLI discovery publication", () => {
  it("does not enable Apps metadata on connector tools", async () => {
    const { entries, activation } = fixture();
    const entry = connector();
    entries.splice(0, entries.length, {
      ...entry,
      tools: [{ ...entry.tools[0], _meta: { ui: { resourceUri: "ui://connector/view" } } }],
    });
    await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    expect(activation.listTools().find((tool) => tool.name.startsWith("mcp_"))).not.toHaveProperty(
      "_meta",
    );
  });
  it("read_skill_document delegates to discovery and exposes tools before returning instructions", async () => {
    const { cli } = fixture();
    const server = createServer(cli, "test", "Organization first");
    const client = new Client({ name: "test", version: "1" });
    const [host, extension] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(extension);
      await client.connect(host);
      const result = await client.callTool({
        name: "read_skill_document",
        arguments: { slug: "review" },
      });
      expect(cli.run.mock.calls[0]![0]).toContain("--skill=review");
      expect(cli.run.mock.calls.every(([args]) => args[0] !== "skills")).toBe(true);
      expect(result).toMatchObject({
        structuredContent: {
          results: [{ status: "active" }, { status: "active", document: skill().document }],
        },
      });
      const exposed = (await client.listTools()).tools.find((tool) =>
        tool.name.startsWith("mcp_"),
      )!;
      expect(exposed.name).toMatch(/^mcp_read_[a-f0-9]{12}$/);
      expect(`weldall__${exposed.name}`.length).toBeLessThanOrEqual(64);
      await client.callTool({ name: exposed.name, arguments: {} });
      expect(cli.run.mock.calls.at(-1)![0]).toEqual(
        expect.arrayContaining([
          "mcp",
          "call",
          "work",
          "read",
          "--connection=alice-work",
          "--expected-subject=alice",
          "--expected-issuer=https://weldall.example",
        ]),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("publishes a healthy source without promoting its overlapping incomplete skill", async () => {
    const { activation, entries } = fixture();
    entries[1] = { ...skill(), status: "incomplete" };
    const outcome = await activation.call("discover_integrations", {
      connectorTypes: ["atlassian-mcp"],
      skills: ["review"],
    });
    expect(outcome).toMatchObject({
      structuredContent: {
        results: [
          { id: "connector:work", status: "active" },
          { id: "skill:review", status: "incomplete" },
        ],
      },
    });
    expect(activation.listTools().some((tool) => tool.name.startsWith("mcp_"))).toBe(true);
  });
  it("continues only an offered account and passes stable bindings back to the resolver", async () => {
    const { activation, cli, entries } = fixture();
    entries.splice(0, entries.length, {
      id: "connector-type:atlassian-mcp",
      kind: "connector",
      key: "atlassian-mcp",
      name: "Atlassian",
      description: "",
      status: "selection_required",
      catalogComplete: true,
      choices: [
        {
          connectorKey: "work",
          connectorName: "Work",
          connectionId: "alice-work",
          name: "Work account",
          accountName: "Alice",
        },
      ],
    });
    await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    await expect(
      activation.call("select_mcp_connection", { connectorKey: "work", connection: "not-offered" }),
    ).rejects.toMatchObject({ code: "mcp_selection" });
    entries.splice(0, entries.length, connector());
    await activation.call("select_mcp_connection", {
      connectorKey: "work",
      connection: "alice-work",
    });
    expect(activation.hasTool("select_mcp_connection")).toBe(false);
    await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    const bindings = cli.run.mock.calls.at(-1)![0].find((arg) => arg.startsWith("--bindings="))!;
    expect(JSON.parse(bindings.slice("--bindings=".length))).toMatchObject([
      {
        selector: "connector-type:atlassian-mcp",
        connectorKey: "work",
        connectionId: "alice-work",
        whole: true,
      },
    ]);
  });
  it("keeps whole-source bindings compact across overlapping selectors", async () => {
    const { activation, entries, cli } = fixture();
    entries.splice(
      0,
      entries.length,
      ...["one", "two"].map((key) => ({
        ...connector(),
        id: `connector:${key}`,
        key,
        selectors: [`connector:${key}`, `connector-type:${key}`],
        route: { connectorKey: key, connectorType: key, connectionId: "account" },
        tools: Array.from({ length: 100 }, (_, i) => ({
          name: `tool_${String(i).padStart(3, "0")}_${"a".repeat(55)}`,
          inputSchema: { type: "object" },
        })),
      })),
    );
    const request = { connectorTypes: ["one", "two"] };
    await activation.call("discover_integrations", request);
    expect(activation.listTools()).toHaveLength(201);
    await expect(activation.call("discover_integrations", request)).resolves.toMatchObject({
      structuredContent: { results: [{ status: "active" }, { status: "active" }] },
    });
    const args = cli.run.mock.calls.at(-1)![0];
    expect(args.join(" ").length).toBeLessThan(24_000);
    const bindings = JSON.parse(args.find((arg) => arg.startsWith("--bindings="))!.slice(11));
    expect(bindings).toHaveLength(4);
    expect(bindings.every((binding: { tools: string[] }) => binding.tools.length === 0)).toBe(true);
  });
  it("rejects binding overflow without poisoning later discovery or forgetting removed accounts", async () => {
    const { activation, entries, cli } = fixture();
    for (let i = 0; i < 33; i++) {
      const key = `source${i}`;
      entries.splice(0, entries.length, {
        ...connector(),
        id: `connector:${key}`,
        key,
        selectors: [`connector:${key}`],
        route: { connectorKey: key, connectorType: "atlassian-mcp", connectionId: "account" },
      });
      const result = await activation.call("discover_integrations", {
        connectorTypes: ["atlassian-mcp"],
      });
      expect(result).toMatchObject({
        structuredContent: { results: [{ status: i < 32 ? "active" : "unavailable" }] },
      });
      await activation.call("discover_integrations", { remove: [`connector:${key}`] });
    }
    expect(activation.listTools()).toHaveLength(1);
    entries.splice(0, entries.length, {
      ...connector(),
      id: "connector:source0",
      key: "source0",
      selectors: ["connector:source0"],
      route: { connectorKey: "source0", connectorType: "atlassian-mcp", connectionId: "account" },
    });
    await expect(
      activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] }),
    ).resolves.toMatchObject({
      structuredContent: { results: [{ status: "active" }] },
    });
    const args = cli.run.mock.calls.at(-1)![0];
    const bindings = JSON.parse(args.find((arg) => arg.startsWith("--bindings="))!.slice(11));
    expect(nativeDiscoveryRequestSchema.shape.bindings.parse(bindings)).toHaveLength(32);
    entries[0] = {
      ...entries[0],
      route: { connectorKey: "source0", connectorType: "atlassian-mcp", connectionId: "other" },
    };
    await expect(
      activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] }),
    ).resolves.toMatchObject({
      structuredContent: { results: [{ code: "bound_connection_unavailable" }] },
    });
  });
  it("rejects oversized exact-tool bindings before changing published tools", async () => {
    const { activation, entries } = fixture();
    await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    const before = activation.listTools();
    entries.splice(0, entries.length, {
      ...connector(),
      whole: false,
      selectors: ["connector:work", "connector-type:atlassian-mcp"],
      tools: Array.from({ length: 100 }, (_, i) => ({
        name: `tool_${String(i).padStart(3, "0")}_${"a".repeat(55)}`,
        inputSchema: { type: "object" },
      })),
    });
    await expect(
      activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] }),
    ).resolves.toMatchObject({
      structuredContent: { results: [{ status: "unavailable", code: "capacity" }] },
    });
    expect(activation.listTools()).toEqual(before);
    entries.splice(0, entries.length, connector());
    await expect(
      activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] }),
    ).resolves.toMatchObject({
      structuredContent: { results: [{ status: "active" }] },
    });
  });
  it("does not silently rebind or claim a skill complete when publication fails", async () => {
    const { activation, entries } = fixture();
    await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    const tool = activation.listTools().find((entry) => entry.name.startsWith("mcp_"))!;
    entries[0] = { ...connector(), route: { ...connector().route, connectionId: "another" } };
    const outcome = await activation.call("discover_integrations", { skills: ["review"] });
    expect(outcome).toMatchObject({
      structuredContent: {
        results: [
          { status: "unavailable", code: "bound_connection_unavailable" },
          { status: "incomplete" },
        ],
      },
    });
    expect(activation.listTools()).toContainEqual(tool);
  });
  it("removes live handlers without forgetting the chosen account or reviving in-flight results", async () => {
    const { activation, cli, entries } = fixture();
    await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    const tool = activation.listTools().find((entry) => entry.name.startsWith("mcp_"))!.name;
    let finish!: (value: string) => void;
    cli.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = activation.call(tool, {});
    await activation.call("discover_integrations", { remove: ["connector:work"] });
    finish(
      JSON.stringify({ content: [{ type: "resource_link", name: "late", uri: "jira://late" }] }),
    );
    await pending;
    expect(activation.listResources()).toEqual([]);
    await expect(activation.call(tool, {})).rejects.toThrow();
    entries.splice(0, entries.length, connector());
    await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    expect(cli.run.mock.calls.at(-1)![0].some((arg) => arg.startsWith("--bindings="))).toBe(true);
  });
  it("coalesces concurrent discovery without letting one cancelled waiter abort another", async () => {
    const { activation, cli } = fixture();
    let finish!: (value: string) => void;
    cli.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = new AbortController();
    const cancelled = activation.call(
      "discover_integrations",
      { connectorTypes: ["atlassian-mcp"] },
      first.signal,
    );
    const live = activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    await Promise.resolve();
    first.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    expect(cli.run).toHaveBeenCalledTimes(1);
    expect(cli.run.mock.calls[0]![1]!.aborted).toBe(false);
    finish(
      JSON.stringify({
        schemaVersion: 1,
        issuer: "https://weldall.example",
        subject: "alice",
        results: [connector()],
      }),
    );
    await expect(live).resolves.toMatchObject({
      structuredContent: { results: [{ status: "active" }] },
    });
  });
  it("clears all authority when the CLI reports a context change", async () => {
    const { activation, cli } = fixture();
    await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    cli.run.mockResolvedValueOnce(
      JSON.stringify({
        schemaVersion: 1,
        issuer: "https://elsewhere.example",
        subject: "bob",
        results: [],
        resetRequired: "identity_changed",
      }),
    );
    expect(
      await activation.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] }),
    ).toMatchObject({ isError: true, structuredContent: { resetRequired: "identity_changed" } });
    expect(activation.listTools()).toHaveLength(1);
    expect(activation.listResources()).toEqual([]);
  });
  it("keeps cancellation isolated to the requesting activation instance", async () => {
    const { activation, cli } = fixture();
    const other = new McpActivation(cli, { tools: async () => {}, resources: async () => {} });
    const controller = new AbortController();
    controller.abort();
    await expect(
      activation.call(
        "discover_integrations",
        { connectorTypes: ["atlassian-mcp"] },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(activation.listResources()).toEqual([]);
    await other.call("discover_integrations", { connectorTypes: ["atlassian-mcp"] });
    expect(other.listResources()).toHaveLength(1);
  });
});
