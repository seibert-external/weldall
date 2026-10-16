import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ErrorCode,
  ListToolsResultSchema,
  ReadResourceResultSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
  FIXTURE_AUTHORIZATION,
  fixtureResources,
  fixtureTools,
  startMcpFixture,
  type FixtureOptions,
  type McpFixture,
} from "./fixtures/mcp-server";
import {
  MCP_LIMITS,
  mcpCallResultSchema,
  mcpReadResultSchema,
  parseMcpResponse,
} from "@weldall/sdk/mcp";
import { discoverMcpResources, discoverMcpTools } from "../src/server/mcp/discovery";

const fixtures: McpFixture[] = [];
async function fixture(options: FixtureOptions = {}) {
  const result = await startMcpFixture(options);
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});

/** Test-only harness. Production will supply connection authorization and DNS-pinned transport. */
async function withClient(
  upstream: McpFixture,
  operation: (client: Client, transport: StreamableHTTPClientTransport) => Promise<unknown>,
  options: { initializeMs?: number; authenticated?: boolean } = {},
) {
  const client = new Client(
    { name: "weldall-fixture-client", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(upstream.endpoint, {
    // Auth refresh belongs to the connector, not the SDK: authProvider can replay POST on 401/403.
    // Even same-origin redirects and SSE resumption are not permitted for this profile.
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1,
      maxReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: (url, init) => {
      if (String(url) !== upstream.endpoint.href) throw new Error("Fixture endpoint mismatch.");
      const headers = new Headers(init?.headers);
      if (options.authenticated !== false) headers.set("authorization", FIXTURE_AUTHORIZATION);
      return fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(2000),
        ]),
      });
    },
  });
  try {
    await client.connect(transport, { timeout: options.initializeMs ?? 1000 });
    return await operation(client, transport);
  } finally {
    try {
      await transport.terminateSession();
    } catch {
      // Best effort cleanup must not replace an operation's outcome or replay it.
    } finally {
      await client.close();
    }
  }
}

function methods(upstream: McpFixture, method: string) {
  return upstream.requests.filter(
    ({ message }) => message && "method" in message && message.method === method,
  );
}

// These tests deliberately exercise the SDK wire behavior separately from future access/DB tests.
// A passing test here is not evidence that a real provider accepts a Weldall REST credential.
describe("deterministic Streamable HTTP MCP fixture", () => {
  it("pins exactly the same official SDK in server and Goose", async () => {
    const app = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const goose = JSON.parse(
      await readFile(new URL("../../goose-extension/package.json", import.meta.url), "utf8"),
    );
    expect(app.dependencies["@modelcontextprotocol/sdk"]).toBe("1.32.1");
    expect(app.dependencies["@modelcontextprotocol/sdk"]).toBe(
      goose.dependencies["@modelcontextprotocol/sdk"],
    );
  });

  it.each(["json", "sse"] as const)(
    "initializes, paginates, calls, reads and terminates a %s session",
    async (responseMode) => {
      const upstream = await fixture({ responseMode });
      await withClient(upstream, async (client, transport) => {
        expect(transport.protocolVersion).toBe("2025-11-25");
        expect(transport.sessionId).toBe("fixture-session-1");
        expect(await discoverMcpTools(client)).toEqual({ tools: fixtureTools });
        expect(await discoverMcpResources(client)).toEqual({ resources: fixtureResources });
        const result = parseMcpResponse(
          mcpCallResultSchema,
          await client.callTool({ name: "fixture.read", arguments: { key: "report" } }),
        );
        expect(result).toMatchObject({ structuredContent: { key: "report" }, isError: false });
        expect(result.content.map((item) => item.type)).toEqual([
          "text",
          "resource_link",
          "resource",
        ]);
        expect(
          parseMcpResponse(
            mcpReadResultSchema,
            await client.readResource({ uri: fixtureResources[0]!.uri }),
          ),
        ).toEqual({
          contents: [
            { uri: "fixture:///report.txt", mimeType: "text/plain", text: "Disposable report." },
          ],
        });
        expect(
          parseMcpResponse(
            mcpReadResultSchema,
            await client.readResource({ uri: fixtureResources[1]!.uri }),
          ),
        ).toEqual({
          contents: [
            { uri: "fixture:///bytes.bin", mimeType: "application/octet-stream", blob: "AAECAw==" },
          ],
        });
      });
      expect(methods(upstream, "initialize")).toHaveLength(1);
      expect(methods(upstream, "notifications/initialized")).toHaveLength(1);
      expect(methods(upstream, "tools/list")).toHaveLength(2);
      expect(methods(upstream, "resources/list")).toHaveLength(2);
      expect(upstream.requests.some((request) => request.method === "GET")).toBe(true);
      expect(upstream.requests.some((request) => request.method === "DELETE")).toBe(true);
      expect(upstream.requests.every((request) => request.authenticated)).toBe(true);
      expect(
        upstream.requests
          .slice(1)
          .every(
            (request) =>
              request.sessionId === "fixture-session-1" && request.protocolVersion === "2025-11-25",
          ),
      ).toBe(true);
      expect(upstream.closedSessions).toEqual(["fixture-session-1"]);
      expect(upstream.sessions.size).toBe(0);
      expect(JSON.stringify(upstream.requests)).not.toContain(FIXTURE_AUTHORIZATION);
    },
  );

  it.each(["tools", "resources"] as const)("bounds %s pagination requests", async (kind) => {
    const upstream = await fixture({
      tools: Array.from({ length: 21 }, (_, index) => ({
        ...fixtureTools[0]!,
        name: `tool${index}`,
      })),
      resources: Array.from({ length: 21 }, (_, index) => ({
        ...fixtureResources[0]!,
        uri: `fixture:///${index}`,
      })),
    });
    await expect(
      withClient(upstream, (client) =>
        kind === "tools" ? discoverMcpTools(client) : discoverMcpResources(client),
      ),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(methods(upstream, `${kind}/list`)).toHaveLength(MCP_LIMITS.pages);
  });

  it("rejects duplicate definitions/repeated cursors without an infinite loop", async () => {
    const upstream = await fixture({ repeatCursor: true });
    await expect(withClient(upstream, (client) => discoverMcpTools(client))).rejects.toMatchObject({
      code: "upstream_protocol_error",
    });
    expect(methods(upstream, "tools/list")).toHaveLength(2);
  });

  it("caps aggregate definitions across otherwise valid pages", async () => {
    const upstream = await fixture({
      pageSize: 10,
      tools: Array.from({ length: 80 }, (_, index) => ({
        ...fixtureTools[0]!,
        name: `tool${index}`,
        description: "x".repeat(14 * 1024),
      })),
    });
    await expect(withClient(upstream, (client) => discoverMcpTools(client))).rejects.toMatchObject({
      code: "response_too_large",
    });
    expect(methods(upstream, "tools/list")).toHaveLength(8);
  });

  it.each(["tools", "resources"] as const)(
    "caps aggregate %s count across valid pages",
    async (kind) => {
      const upstream = await fixture({
        pageSize: 25,
        tools: Array.from({ length: 101 }, (_, index) => ({
          ...fixtureTools[0]!,
          name: `tool${index}`,
        })),
        resources: Array.from({ length: 101 }, (_, index) => ({
          ...fixtureResources[0]!,
          uri: `fixture:///${index}`,
        })),
      });
      await expect(
        withClient(upstream, (client) =>
          kind === "tools" ? discoverMcpTools(client) : discoverMcpResources(client),
        ),
      ).rejects.toMatchObject({ code: "response_too_large" });
      expect(methods(upstream, `${kind}/list`)).toHaveLength(5);
    },
  );

  it("sanitizes SDK errors rather than returning upstream response bodies", async () => {
    const upstream = await fixture({
      fault: { method: "tools/list", kind: "http-error", status: 401 },
    });
    await expect(withClient(upstream, (client) => discoverMcpTools(client))).rejects.toMatchObject({
      code: "upstream_authentication_failed",
      message: "The MCP server rejected this connection.",
    });
  });

  it("does not advertise or service server-initiated roots requests", async () => {
    const reply = Promise.withResolvers<JSONRPCMessage>();
    const upstream = await fixture({
      onRequest: ({ message }) => {
        if (message && "id" in message && message.id === "unsupported-roots")
          reply.resolve(message);
      },
    });
    await withClient(upstream, async (client, transport) => {
      await client.listTools();
      await upstream.sessions
        .get(transport.sessionId!)!
        .transport.send({ jsonrpc: "2.0", id: "unsupported-roots", method: "roots/list" });
      expect(await reply.promise).toMatchObject({ error: { code: ErrorCode.MethodNotFound } });
    });
    expect(methods(upstream, "initialize")[0]?.message).toMatchObject({
      params: { capabilities: {} },
    });
  });

  it("isolates short-lived sessions", async () => {
    const upstream = await fixture();
    for (let index = 0; index < 2; index++)
      await withClient(upstream, (client) => client.listTools());
    expect(upstream.closedSessions).toEqual(["fixture-session-1", "fixture-session-2"]);
    expect(upstream.sessions.size).toBe(0);
  });

  it("refuses missing authentication before creating a session", async () => {
    const upstream = await fixture();
    await expect(
      withClient(upstream, (client) => client.listTools(), { authenticated: false }),
    ).rejects.toThrow();
    expect(methods(upstream, "initialize")).toHaveLength(1);
    expect(methods(upstream, "tools/list")).toHaveLength(0);
    expect(upstream.sessions.size).toBe(0);
  });

  it("preserves tool business errors and rejects unknown tools/resources", async () => {
    const upstream = await fixture();
    await withClient(upstream, async (client) => {
      expect(await client.callTool({ name: "fixture.error" })).toMatchObject({ isError: true });
      await expect(client.callTool({ name: "missing" })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
      await expect(client.readResource({ uri: "fixture:///missing" })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
    });
  });

  it.each(["malformed-json", "invalid-result", "redirect"] as const)(
    "rejects %s without following or replaying",
    async (kind) => {
      const upstream = await fixture({ fault: { method: "tools/list", kind } });
      await expect(withClient(upstream, (client) => client.listTools())).rejects.toThrow();
      expect(methods(upstream, "tools/list")).toHaveLength(1);
      expect(upstream.closedSessions).toEqual(["fixture-session-1"]);
    },
  );

  it.each([401, 403, 404, 429, 500, 503])(
    "never retries a tool POST after HTTP %s",
    async (status) => {
      const upstream = await fixture({
        fault: { method: "tools/call", kind: "http-error", status },
      });
      await expect(
        withClient(upstream, (client) => client.callTool({ name: "fixture.write" })),
      ).rejects.toThrow();
      expect(methods(upstream, "tools/call")).toHaveLength(1);
      expect(methods(upstream, "initialize")).toHaveLength(1);
    },
  );

  it("never replays an ambiguous write after the server applied its effect and dropped the response", async () => {
    const upstream = await fixture({
      fault: { method: "tools/call", kind: "drop-after-dispatch" },
    });
    await expect(
      withClient(upstream, (client) => client.callTool({ name: "fixture.write" })),
    ).rejects.toThrow();
    expect(upstream.effects).toBe(1);
    expect(methods(upstream, "tools/call")).toHaveLength(1);
  });

  it("does not resume an interrupted SSE POST even when the server provides an event ID", async () => {
    const upstream = await fixture({ fault: { method: "tools/call", kind: "sse-disconnect" } });
    await expect(
      withClient(upstream, (client) =>
        client.callTool({ name: "fixture.write" }, CallToolResultSchema, { timeout: 100 }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    expect(methods(upstream, "tools/call")).toHaveLength(1);
    expect(upstream.requests.filter((request) => request.method === "GET")).toHaveLength(1);
  });

  it("bounds initialization and closes sockets when it times out", async () => {
    const upstream = await fixture({ delayMethod: "initialize" });
    await expect(
      withClient(upstream, (client) => client.listTools(), { initializeMs: 50 }),
    ).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    expect(methods(upstream, "initialize")).toHaveLength(1);
    expect(methods(upstream, "tools/list")).toHaveLength(0);
    await upstream.close();
    expect(upstream.sessions.size).toBe(0);
  });

  it.each(["tools/list", "tools/call", "resources/read"] as const)(
    "propagates the %s deadline through notifications/cancelled",
    async (method) => {
      const upstream = await fixture({ delayMethod: method });
      await expect(
        withClient(upstream, (client) => {
          if (method === "tools/list")
            return client.request({ method }, ListToolsResultSchema, { timeout: 100 });
          if (method === "resources/read")
            return client.request(
              { method, params: { uri: fixtureResources[0]!.uri } },
              ReadResourceResultSchema,
              { timeout: 100 },
            );
          return client.callTool({ name: "fixture.write" }, CallToolResultSchema, { timeout: 100 });
        }),
      ).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
      expect(methods(upstream, method)).toHaveLength(1);
      expect(methods(upstream, "notifications/cancelled")).toHaveLength(1);
      expect(upstream.cancelledRequests).toHaveLength(1);
      expect(upstream.effects).toBe(0);
    },
  );

  it("propagates explicit caller cancellation after dispatch without a retry", async () => {
    const seen = Promise.withResolvers<void>();
    const controller = new AbortController();
    const upstream = await fixture({
      delayMethod: "tools/call",
      onRequest: ({ message }) => {
        if (message && "method" in message && message.method === "tools/call") seen.resolve();
      },
    });
    const operation = withClient(upstream, (client) =>
      client.callTool({ name: "fixture.write" }, CallToolResultSchema, {
        signal: controller.signal,
      }),
    );
    const rejected = expect(operation).rejects.toThrow();
    await seen.promise;
    controller.abort(new Error("Caller cancelled."));
    await rejected;
    expect(methods(upstream, "tools/call")).toHaveLength(1);
    expect(methods(upstream, "notifications/cancelled")).toHaveLength(1);
    expect(upstream.effects).toBe(0);
  });
});
