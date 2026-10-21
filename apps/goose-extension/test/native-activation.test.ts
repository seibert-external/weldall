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
  const interactive = (key: string, allowedTools = ["read"]) => ({
    ...source(key),
    resources: [
      {
        uri: "ui://demo/view",
        name: "View",
        mimeType: "text/html;profile=mcp-app",
        _meta: { ui: { allowedTools } },
      },
    ],
  });
  const handle = (result: Awaited<ReturnType<McpActivation["read"]>>) =>
    (result.contents[0]!._meta as Record<string, { viewToken: string }>)[
      "weldall/resource-tool-calls"
    ]!.viewToken;

  it("dispatches app-only calls through the real MCP server with a host-bound source, not UI routing", async () => {
    const { cli, state } = fixture();
    state.entries = [interactive("expenses"), interactive("other")];
    const server = createServer(cli, "test", "");
    const client = new Client({ name: "host", version: "1" });
    const [host, extension] = InMemoryTransport.createLinkedPair();
    closers.push(
      () => client.close(),
      () => server.close(),
    );
    await server.connect(extension);
    await client.connect(host);
    expect(client.getInstructions()).toContain(
      "use discover_integrations as the primary entry point",
    );
    expect(client.getInstructions()).not.toContain("use search_skills first");
    await client.callTool({
      name: "discover_integrations",
      arguments: { resources: ["expenses", "other"] },
    });
    const dispatch = (await client.listTools()).tools.find(
      (t) => t.name === "call_resource_ui_tool",
    )!;
    expect(dispatch._meta).toEqual({ ui: { visibility: ["app"] } });
    const resources = (await client.listResources()).resources;
    const read = await client.readResource({ uri: resources[0]!.uri });
    const viewToken = handle(read);
    expect(JSON.stringify(read.contents[0]!.text)).not.toContain(viewToken);
    const result = await client.callTool({
      name: dispatch.name,
      arguments: { viewToken, name: "read", arguments: { decision: "approve" } },
    });
    expect(result).toMatchObject({ content: [{ text: "ok" }] });
    expect(cli.run.mock.calls.filter(([args]) => args[2] === "call")).toHaveLength(1);
    expect(cli.run.mock.calls.at(-1)![0]).toEqual(
      expect.arrayContaining([
        "expenses",
        "read",
        "--expected-subject=alice",
        "--expected-resource-identifier=https://expenses.example/api",
      ]),
    );
    for (const name of [
      "send",
      "discover_integrations",
      "call_resource_ui_tool",
      "native_read_foreign",
    ]) {
      expect(
        await client.callTool({ name: dispatch.name, arguments: { viewToken, name } }),
      ).toMatchObject({ isError: true });
    }
    expect(
      await client.callTool({
        name: dispatch.name,
        arguments: { viewToken, name: "read", resourceKey: "other" },
      }),
    ).toMatchObject({ isError: true });
    expect(cli.run.mock.calls.filter(([args]) => args[2] === "call")).toHaveLength(1);
  });

  it.each(["remove", "revision", "identity"])(
    "invalidates old view handles after %s without executing",
    async (change) => {
      const f = fixture();
      f.state.entries = [interactive("expenses")];
      await f.activation.call("discover_integrations", { resources: ["expenses"] });
      const token = handle(await f.activation.read(f.activation.listResources()[0]!.uri));
      if (change === "identity") f.state.subject = "bob";
      if (change === "revision")
        f.state.entries = [
          {
            ...interactive("expenses"),
            route: { ...source("expenses").route, revision: "b".repeat(64) },
          },
        ];
      await f.activation.call(
        "discover_integrations",
        change === "remove" ? { remove: ["resource:expenses"] } : { resources: ["expenses"] },
      );
      await expect(
        f.activation.call("call_resource_ui_tool", { viewToken: token, name: "read" }),
      ).rejects.toThrow();
      for (const uri of [undefined, "fixture://text"]) {
        await expect(
          f.activation.call("read_resource_ui_resource", {
            viewToken: token,
            ...(uri ? { uri } : {}),
          }),
        ).rejects.toThrow();
      }
      expect(f.cli.run.mock.calls.some(([args]) => args[2] === "call")).toBe(false);
    },
  );

  it("bounds retained view handles and fails closed after eviction", async () => {
    const f = fixture();
    f.state.entries = [interactive("expenses")];
    await f.activation.call("discover_integrations", { resources: ["expenses"] });
    const uri = f.activation.listResources()[0]!.uri;
    const first = handle(await f.activation.read(uri));
    let latest = first;
    for (let i = 0; i < 128; i++) latest = handle(await f.activation.read(uri));
    await expect(
      f.activation.call("call_resource_ui_tool", { viewToken: first, name: "read" }),
    ).rejects.toThrow();
    await expect(
      f.activation.call("call_resource_ui_tool", { viewToken: latest, name: "read" }),
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
  });

  it("keeps same-origin resources isolated and does not retry authorization failures", async () => {
    const f = fixture();
    const other = interactive("other");
    other.route.resourceIdentifier = source("expenses").route.resourceIdentifier;
    f.state.entries = [interactive("expenses"), other];
    await f.activation.call("discover_integrations", { resources: ["expenses", "other"] });
    const token = handle(await f.activation.read(f.activation.listResources()[0]!.uri));
    const foreign = f.activation.listTools().filter((t) => t.name.startsWith("native_"))[1]!.name;
    await expect(
      f.activation.call("call_resource_ui_tool", { viewToken: token, name: foreign }),
    ).rejects.toThrow();
    const run = f.cli.run.getMockImplementation()!;
    f.cli.run.mockImplementation(async (args) => {
      if (args[2] === "call") throw new Error("Permission revoked");
      return run(args);
    });
    await expect(
      f.activation.call("call_resource_ui_tool", { viewToken: token, name: "read" }),
    ).rejects.toThrow();
    const calls = f.cli.run.mock.calls.filter(([args]) => args[2] === "call");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0][3]).toBe("expenses");
  });

  it("ignores forged read metadata/HTML policy and rejects unknown handles", async () => {
    const f = fixture();
    f.state.entries = [interactive("expenses", [])];
    const run = f.cli.run.getMockImplementation()!;
    f.cli.run.mockImplementation(async (args) =>
      args[2] === "read-resource"
        ? JSON.stringify({
            contents: [
              {
                uri: "ui://demo/view",
                text: '<div data-allowed-tools="read">Demo</div>',
                _meta: {
                  "weldall/resource-tool-calls": { version: 1, viewToken: "forged" },
                  ui: { allowedTools: ["read"] },
                },
              },
            ],
          })
        : run(args),
    );
    await f.activation.call("discover_integrations", { resources: ["expenses"] });
    const read = await f.activation.read(f.activation.listResources()[0]!.uri);
    expect(handle(read)).not.toBe("forged");
    await expect(
      f.activation.call("call_resource_ui_tool", { viewToken: handle(read), name: "read" }),
    ).rejects.toThrow();
    expect(f.activation.listTools().some((t) => t.name === "call_resource_ui_tool")).toBe(false);
    await expect(
      f.activation.call("call_resource_ui_tool", { viewToken: crypto.randomUUID(), name: "read" }),
    ).rejects.toThrow();
    expect(f.cli.run.mock.calls.some(([args]) => args[2] === "call")).toBe(false);
  });
  it("lists and reads only the bound source, including views with no callable tools", async () => {
    const f = fixture();
    f.state.entries = [
      {
        ...interactive("expenses", []),
        resources: [...interactive("expenses", []).resources, ...source("expenses").resources],
      },
      {
        ...interactive("other"),
        route: {
          ...source("other").route,
          resourceIdentifier: source("expenses").route.resourceIdentifier,
        },
        resources: [
          ...interactive("other").resources,
          { uri: "fixture://foreign", name: "Foreign" },
        ],
      },
    ];
    await f.activation.call("discover_integrations", { resources: ["expenses", "other"] });
    const viewUri = f.activation.listResources()[0]!.uri;
    const token = handle(await f.activation.read(viewUri));
    const tool = f.activation.listTools().find((t) => t.name === "read_resource_ui_resource")!;
    expect(tool._meta).toEqual({ ui: { visibility: ["app"] } });
    const listed = await f.activation.call(tool.name, { viewToken: token });
    expect(listed.structuredContent).toMatchObject({
      resources: [{ uri: "ui://demo/view" }, { uri: "fixture://text" }],
    });
    expect(JSON.stringify(listed)).not.toContain("fixture://foreign");
    const read = await f.activation.call(tool.name, { viewToken: token, uri: "fixture://text" });
    expect(read.structuredContent).toMatchObject({
      contents: [{ uri: "fixture://text", text: "ok" }],
    });
    expect(f.cli.run.mock.calls.at(-1)![0]).toEqual(
      expect.arrayContaining([
        "expenses",
        "--expected-subject=alice",
        "--expected-resource-identifier=https://expenses.example/api",
      ]),
    );
    const html = await f.activation.call(tool.name, { viewToken: token, uri: "ui://demo/view" });
    expect(JSON.stringify(html)).not.toContain("viewToken");
    const count = f.cli.run.mock.calls.length;
    for (const args of [
      { viewToken: token, uri: "fixture://foreign" },
      { viewToken: token, uri: "https://other.example/api" },
      { viewToken: token, uri: viewUri },
      { viewToken: token, uri: "fixture://text", resourceKey: "other" },
    ])
      await expect(f.activation.call(tool.name, args)).rejects.toThrow();
    expect(f.cli.run.mock.calls).toHaveLength(count);
    const run = f.cli.run.getMockImplementation()!;
    f.cli.run.mockImplementation(async (args) => {
      if (args[2] === "read-resource") throw new Error("Authorization revoked");
      return run(args);
    });
    await expect(
      f.activation.call(tool.name, { viewToken: token, uri: "fixture://text" }),
    ).rejects.toThrow();
    expect(f.cli.run.mock.calls).toHaveLength(count + 1);
    await f.activation.call("discover_integrations", { remove: ["resource:expenses"] });
    await expect(f.activation.call(tool.name, { viewToken: token })).rejects.toThrow();
  });

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
  it("publishes a native UI reference and serves sanitized HTML/CSS through the real MCP server", async () => {
    const { cli, state } = fixture();
    const uiUri = "ui://expenses/view";
    const objectOrigin = "https://contracts.finance.seibert.diy";
    const connectOrigin = "https://api.expenses.example";
    const entry = source("expenses");
    state.entries = [
      {
        ...entry,
        tools: [{ ...entry.tools[0], _meta: { ui: { resourceUri: uiUri } } }],
        resources: [{ uri: uiUri, name: "Expenses UI", mimeType: "text/html;profile=mcp-app" }],
      },
    ];
    const run = cli.run.getMockImplementation()!;
    cli.run.mockImplementation(async (args) =>
      args[2] === "read-resource"
        ? JSON.stringify({
            contents: [
              {
                uri: uiUri,
                mimeType: "text/html;profile=mcp-app",
                text: `<h1>Expenses</h1><link rel="stylesheet" href="https://expenses.example/ui.css"><object data="${objectOrigin}/contract.pdf" type="application/pdf"></object><script>parent.postMessage({method:"tools/call"},"*")</script>`,
                _meta: {
                  ui: {
                    csp: {
                      resourceDomains: ["https://expenses.example", objectOrigin],
                      connectDomains: [connectOrigin],
                    },
                  },
                  goose: { mcpApp: {} },
                },
              },
            ],
          })
        : run(args),
    );
    const server = createServer(cli, "test", "");
    const client = new Client({ name: "test", version: "1" });
    const [host, extension] = InMemoryTransport.createLinkedPair();
    closers.push(
      () => client.close(),
      () => server.close(),
    );
    await server.connect(extension);
    await client.connect(host);
    await client.callTool({
      name: "discover_integrations",
      arguments: { resources: ["expenses"] },
    });
    const tool = (await client.listTools()).tools.find((item) => item.name.startsWith("native_"))!;
    const localUri = (tool._meta?.ui as { resourceUri: string }).resourceUri;
    expect(localUri).toMatch(/^ui:\/\/native-/);
    expect(localUri).not.toBe(uiUri);
    expect(tool._meta?.ui).toMatchObject({ visibility: ["model"] });
    expect((await client.listResources()).resources[0]!.uri).toBe(localUri);
    expect(await client.callTool({ name: tool.name, arguments: {} })).toMatchObject({
      content: [{ text: "ok" }],
    });
    const result = await client.readResource({ uri: localUri });
    const html = String(result.contents[0]!.text);
    expect(html).toContain("<h1>Expenses</h1>");
    expect(html).toContain('href="https://expenses.example/ui.css"');
    expect(html).toContain("script-src &#39;sha256-");
    expect(html).toContain(`connect-src ${connectOrigin}`);
    expect(html).toContain("object-src &#39;none&#39;");
    expect(html).not.toContain("<object");
    expect(html).not.toContain('parent.postMessage({method:"tools/call"}');
    expect(result.contents[0]!._meta).toMatchObject({
      ui: {
        csp: {
          resourceDomains: ["https://expenses.example"],
          connectDomains: [connectOrigin],
        },
        prefersBorder: true,
      },
      "weldall/resource-tool-calls": { version: 1, viewToken: expect.any(String) },
    });
    expect(cli.run.mock.calls.at(-1)![0]).toContain(`--uri=${uiUri}`);
    await expect(client.readResource({ uri: uiUri })).rejects.toThrow();
  });

  it("keeps executable asset authority source-bound while forwarding CSP domains", async () => {
    const { state, activation, cli } = fixture();
    state.entries = [
      {
        ...source("expenses"),
        resources: [{ uri: "ui://app/view", name: "UI", mimeType: "text/html;profile=mcp-app" }],
      },
    ];
    await activation.call("discover_integrations", { resources: ["expenses"] });
    cli.run.mockResolvedValueOnce(
      JSON.stringify({
        contents: [
          {
            uri: "ui://app/view",
            text: '<script type="module" src="https://expenses.example/app.js"></script><script type="module" src="https://evil.example/app.js"></script>',
            _meta: { ui: { csp: { resourceDomains: ["https://evil.example"] } } },
          },
        ],
      }),
    );
    const result = await activation.read(activation.listResources()[0]!.uri);
    expect(result.contents[0]!.text).toContain('"scriptUrls":["https://expenses.example/app.js"]');
    expect(result.contents[0]!.text).not.toContain("https://evil.example/app.js");
    expect(result.contents[0]!._meta).toMatchObject({
      ui: {
        csp: {
          resourceDomains: ["https://expenses.example"],
          connectDomains: [],
        },
      },
    });
  });

  it("does not forward provider object or asset allowlists", async () => {
    const { state, activation, cli } = fixture();
    state.entries = [
      {
        ...source("expenses"),
        resources: [{ uri: "ui://app/view", name: "UI", mimeType: "text/html;profile=mcp-app" }],
      },
    ];
    await activation.call("discover_integrations", { resources: ["expenses"] });
    cli.run.mockResolvedValueOnce(
      JSON.stringify({
        contents: [
          {
            uri: "ui://app/view",
            text: "<h1>Expenses</h1>",
            _meta: {
              ui: {
                csp: {
                  resourceDomains: Array.from(
                    { length: 16 },
                    (_, index) => `https://domain-${index}.example`,
                  ),
                },
              },
            },
          },
        ],
      }),
    );
    const result = await activation.read(activation.listResources()[0]!.uri);
    expect(result.contents[0]!._meta).toMatchObject({
      ui: { csp: { resourceDomains: ["https://expenses.example"], connectDomains: [] } },
    });
    expect(result.contents[0]!.text).not.toContain("domain-0.example");
  });

  it("keeps identical UI URIs source-bound and removes only the selected source", async () => {
    const { state, activation, cli } = fixture();
    const uiUri = "ui://app/view";
    state.entries = ["expenses", "billing"].map((key) => ({
      ...source(key),
      tools: [
        { name: "show", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: uiUri } } },
      ],
      resources: [{ uri: uiUri, name: "UI", mimeType: "text/html;profile=mcp-app" }],
    }));
    await activation.call("discover_integrations", { resources: ["expenses", "billing"] });
    const uris = activation
      .listTools()
      .filter((tool) => tool.name.startsWith("native_"))
      .map((tool) => (tool._meta?.ui as { resourceUri: string }).resourceUri);
    expect(new Set(uris).size).toBe(2);
    for (const [index, key] of ["expenses", "billing"].entries()) {
      cli.run.mockResolvedValueOnce(
        JSON.stringify({ contents: [{ uri: uiUri, text: "<h1>UI</h1>" }] }),
      );
      await activation.read(uris[index]!);
      expect(cli.run.mock.calls.at(-1)![0].slice(0, 4)).toEqual([
        "mcp",
        "native",
        "read-resource",
        key,
      ]);
    }
    await activation.call("discover_integrations", { remove: ["resource:expenses"] });
    await expect(activation.read(uris[0]!)).rejects.toThrow();
    expect(activation.listResources().map((resource) => resource.uri)).toEqual([uris[1]]);
  });

  it("rejects an in-flight UI read after its source binding is removed", async () => {
    const { state, activation, cli } = fixture();
    state.entries = [
      {
        ...source("expenses"),
        resources: [{ uri: "ui://app/view", name: "UI", mimeType: "text/html;profile=mcp-app" }],
      },
    ];
    await activation.call("discover_integrations", { resources: ["expenses"] });
    let finish!: (value: string) => void;
    cli.run.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = activation.read(activation.listResources()[0]!.uri);
    await activation.call("discover_integrations", { remove: ["resource:expenses"] });
    finish(JSON.stringify({ contents: [{ uri: "ui://app/view", text: "<h1>Old identity</h1>" }] }));
    await expect(pending).rejects.toThrow();
    expect(activation.listResources()).toEqual([]);
  });

  it.each(["missing", "wrong-mime"])(
    "rejects a %s UI resource before publishing any tool",
    async (reason) => {
      const { state, activation } = fixture();
      const entry = source("expenses");
      state.entries = [
        {
          ...entry,
          tools: [{ ...entry.tools[0], _meta: { ui: { resourceUri: "ui://expenses/view" } } }],
          resources:
            reason === "missing"
              ? []
              : [{ uri: "ui://expenses/view", name: "Not HTML", mimeType: "application/json" }],
        },
      ];
      expect(
        await activation.call("discover_integrations", { resources: ["expenses"] }),
      ).toMatchObject({
        structuredContent: { results: [{ status: "unavailable" }] },
      });
      expect(activation.listTools().filter((tool) => tool.name.startsWith("native_"))).toEqual([]);
    },
  );

  it.each([undefined, "application/json", "text/html;profile=mcp-app"])(
    "sanitizes base64 UI content even with response MIME %s",
    async (mimeType) => {
      const { state, activation, cli } = fixture();
      const entry = source("expenses");
      state.entries = [
        {
          ...entry,
          resources: [
            { uri: "ui://expenses/view", name: "UI", mimeType: "text/html;profile=mcp-app" },
          ],
        },
      ];
      await activation.call("discover_integrations", { resources: ["expenses"] });
      cli.run.mockResolvedValueOnce(
        JSON.stringify({
          contents: [
            {
              uri: "ui://expenses/view",
              mimeType,
              blob: Buffer.from(
                '<h1>Safe</h1><meta http-equiv="refresh" content="0;url=https://evil.example"><script>evil()</script>',
              ).toString("base64"),
            },
          ],
        }),
      );
      const result = await activation.read(activation.listResources()[0]!.uri);
      expect(result.contents[0]).toMatchObject({
        mimeType: "text/html;profile=mcp-app",
        text: expect.stringContaining("<h1>Safe</h1>"),
      });
      expect(result.contents[0]).not.toHaveProperty("blob");
      expect(result.contents[0]!.text).not.toContain("evil");
    },
  );

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
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(activation.listResources()).toHaveLength(1);
    const count = cli.run.mock.calls.length;
    await expect(activation.read(oldLinkedUri)).rejects.toMatchObject({ code: "invalid_request" });
    expect(cli.run).toHaveBeenCalledTimes(count);
  });
  it("does not return an old identity's in-flight resource result", async () => {
    const { state, activation, cli } = fixture();
    await activation.call("discover_integrations", { resources: ["expenses"] });
    const uri = activation.listResources()[0]!.uri;
    let finish!: (value: string) => void;
    cli.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = activation.read(uri);
    state.subject = "bob";
    await activation.call("discover_integrations", { resources: ["expenses"] });
    finish(JSON.stringify({ contents: [{ uri: "fixture://private", text: "alice-secret" }] }));
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(activation.listResources()).toHaveLength(1);
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
