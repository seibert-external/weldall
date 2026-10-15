import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  JSONRPCMessageSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type JSONRPCMessage,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/** Fake credentials only. This fixture never reads the environment, database, or local secrets. */
export const FIXTURE_AUTHORIZATION = "Bearer disposable-mcp-fixture-sentinel";
export const fixtureTools: Tool[] = [
  {
    name: "fixture.read",
    description: "Read disposable fixture data.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "fixture.write",
    description: "Increment an in-memory counter; never retry an ambiguous result.",
    inputSchema: { type: "object", additionalProperties: false },
  },
];
export const fixtureResources: Resource[] = [
  { uri: "fixture:///report.txt", name: "Report", mimeType: "text/plain" },
  { uri: "fixture:///bytes.bin", name: "Bytes", mimeType: "application/octet-stream" },
];

export type FixtureRequest = {
  method: string;
  authenticated: boolean;
  sessionId?: string | undefined;
  protocolVersion?: string | undefined;
  message?: JSONRPCMessage | undefined;
};
export type FixtureFault = {
  method: string;
  kind:
    | "http-error"
    | "redirect"
    | "malformed-json"
    | "invalid-result"
    | "drop-after-dispatch"
    | "sse-disconnect";
  status?: number;
};
export type FixtureOptions = {
  responseMode?: "json" | "sse";
  tools?: Tool[];
  resources?: Resource[];
  pageSize?: number;
  repeatCursor?: boolean;
  delayMethod?: string;
  delayMs?: number;
  fault?: FixtureFault;
  onRequest?: (request: FixtureRequest) => void;
};

/**
 * Actual loopback HTTP + the official MCP server SDK, not a fetch/transport mock.
 * Each initialize creates an independent session. All state is disposable and close()
 * awaits session, listener, timer, and socket cleanup. Production never imports this file.
 */
export async function startMcpFixture(options: FixtureOptions = {}) {
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  const requests: FixtureRequest[] = [];
  const closedSessions: string[] = [];
  const cancelledRequests: (string | number)[] = [];
  const pending = new Set<Promise<void>>();
  const shutdown = new AbortController();
  let sequence = 0;
  let effects = 0;
  let closed = false;
  const pageSize = options.pageSize ?? 1;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    throw new Error("Invalid fixture page size.");

  function page<T>(items: T[], cursor: string | undefined, prefix: string) {
    const offset = cursor === undefined ? 0 : Number(cursor.slice(prefix.length));
    if (
      (cursor !== undefined && !cursor.startsWith(prefix)) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > items.length
    )
      throw new McpError(ErrorCode.InvalidParams, "Invalid fixture cursor.");
    const next = offset + pageSize;
    return {
      items: items.slice(offset, next),
      ...(next < items.length || options.repeatCursor
        ? { nextCursor: options.repeatCursor ? `${prefix}0` : `${prefix}${next}` }
        : {}),
    };
  }

  async function createSession() {
    const server = new Server(
      { name: "weldall-disposable-mcp", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `fixture-session-${++sequence}`,
      enableJsonResponse: options.responseMode !== "sse",
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
      onsessionclosed: (id) => {
        closedSessions.push(id);
        sessions.delete(id);
      },
    });
    const beforeOperation = async (
      method: string,
      signal: AbortSignal,
      requestId: string | number,
    ) => {
      if (options.delayMethod !== method) return;
      const combined = AbortSignal.any([signal, shutdown.signal]);
      try {
        await delay(options.delayMs ?? 30_000, undefined, { signal: combined });
      } catch {
        if (signal.aborted) cancelledRequests.push(requestId);
        throw new McpError(ErrorCode.InternalError, "Fixture operation cancelled.");
      }
    };
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      await beforeOperation(request.method, extra.signal, extra.requestId);
      const result = page(options.tools ?? fixtureTools, request.params?.cursor, "tools:");
      return {
        tools: result.items,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
      await beforeOperation(request.method, extra.signal, extra.requestId);
      const result = page(
        options.resources ?? fixtureResources,
        request.params?.cursor,
        "resources:",
      );
      return {
        resources: result.items,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      await beforeOperation(request.method, extra.signal, extra.requestId);
      if (request.params.name === "fixture.write") {
        effects++;
        return {
          content: [{ type: "text", text: "Updated fixture." }],
          structuredContent: { effects },
        };
      }
      if (request.params.name === "fixture.error")
        return { content: [{ type: "text", text: "Fixture business error." }], isError: true };
      if (request.params.name !== "fixture.read")
        throw new McpError(ErrorCode.InvalidParams, "Unknown fixture tool.");
      return {
        content: [
          { type: "text", text: "Disposable report." },
          { type: "resource_link", ...fixtureResources[0] },
          {
            type: "resource",
            resource: { uri: "fixture:///report.txt", text: "Disposable report." },
          },
        ],
        structuredContent: { key: request.params.arguments?.key ?? "report" },
        isError: false,
      };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      await beforeOperation(request.method, extra.signal, extra.requestId);
      if (request.params.uri === fixtureResources[0]!.uri)
        return {
          contents: [
            { uri: request.params.uri, mimeType: "text/plain", text: "Disposable report." },
          ],
        };
      if (request.params.uri === fixtureResources[1]!.uri)
        return {
          contents: [
            { uri: request.params.uri, mimeType: "application/octet-stream", blob: "AAECAw==" },
          ],
        };
      throw new McpError(ErrorCode.InvalidParams, "Unknown fixture resource.");
    });
    await server.connect(transport);
    return { server, transport };
  }

  async function readMessage(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const value of request) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("Fixture request limit exceeded.");
      chunks.push(chunk);
    }
    return JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const authenticated = request.headers.authorization === FIXTURE_AUTHORIZATION;
    const message = request.method === "POST" ? await readMessage(request) : undefined;
    const entry: FixtureRequest = {
      method: request.method!,
      authenticated,
      sessionId: request.headers["mcp-session-id"] as string | undefined,
      protocolVersion: request.headers["mcp-protocol-version"] as string | undefined,
      message,
    };
    requests.push(entry);
    options.onRequest?.(entry);
    if (!authenticated) {
      response.writeHead(401, { "www-authenticate": 'Bearer realm="disposable-fixture"' }).end();
      return;
    }
    const method = message && "method" in message ? message.method : undefined;
    const fault = options.fault;
    if (fault && method === fault.method && message && "id" in message) {
      switch (fault.kind) {
        case "http-error":
          response.writeHead(fault.status ?? 503).end("Untrusted fixture error body.");
          return;
        case "redirect":
          response.writeHead(307, { location: "/redirect-target" }).end();
          return;
        case "malformed-json":
          response.writeHead(200, { "content-type": "application/json" }).end("{not-json");
          return;
        case "invalid-result":
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(
              JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: "not-an-array" } }),
            );
          return;
        case "drop-after-dispatch":
          effects++;
          response.destroy();
          return;
        case "sse-disconnect":
          response
            .writeHead(200, { "content-type": "text/event-stream" })
            .end("id: resume-1\nretry: 1\n\n");
          return;
      }
    }
    if (method === "initialize" && options.delayMethod === method)
      await delay(options.delayMs ?? 30_000, undefined, { signal: shutdown.signal });
    let session = entry.sessionId ? sessions.get(entry.sessionId) : undefined;
    if (!session && !entry.sessionId && isInitializeRequest(message))
      session = await createSession();
    if (!session) {
      response.writeHead(404).end();
      return;
    }
    // In JSON response mode the SDK suppresses replies to cancelled requests, so
    // handleRequest can remain pending even after the client has closed its socket.
    // Treat the HTTP response's close event as completion of this fixture request.
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        response.removeListener("close", finish);
        resolve();
      };
      response.once("close", finish);
      void session.transport.handleRequest(request, response, message).then(finish, (error) => {
        response.removeListener("close", finish);
        reject(error);
      });
    });
  }

  const http = createServer((request, response) => {
    const operation = handle(request, response).catch(() => {
      // Never echo exception messages, request headers, or request bodies.
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP.");
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
    requests,
    sessions,
    closedSessions,
    cancelledRequests,
    get effects() {
      return effects;
    },
    async close() {
      if (closed) return;
      closed = true;
      shutdown.abort();
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      sessions.clear();
      const stopped = new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
      http.closeAllConnections();
      await Promise.all([stopped, ...pending]);
    },
  };
}

export type McpFixture = Awaited<ReturnType<typeof startMcpFixture>>;
