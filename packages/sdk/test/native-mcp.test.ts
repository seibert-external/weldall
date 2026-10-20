import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import {
  createDpopProof,
  generateEs256KeyPair,
  inMemory,
  initWeldall,
  issueAccessToken,
  MACHINE_TOKEN_TYP,
  signEs256,
  type DpopKeyPair,
} from "../src/index.js";
import { initWeldall as initHono } from "../src/hono.js";
import { createNativeMcp } from "../src/mcp/server.js";
import type { WeldallOptions } from "../src/types.js";

const host = "https://weldall.example";
const origin = "https://expenses.example";
const endpoint = `${origin}/api/mcp`;
let signing: DpopKeyPair;
let issuer: DpopKeyPair;
let device: DpopKeyPair;
let options: WeldallOptions;
const write = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }] }));
const mcp = (discoveryScopes: string[]) =>
  createNativeMcp({
    path: "/api/mcp",
    description: "Expenses",
    discoveryScopes,
    tools: [
      {
        name: "whoami",
        scopes: ["read"],
        inputSchema: { type: "object", additionalProperties: false },
        async handler(_, { auth }) {
          return {
            content: [{ type: "text", text: auth.subject }],
            structuredContent: { identityType: auth.identityType },
          };
        },
      },
      {
        name: "write",
        scopes: ["write"],
        inputSchema: {
          type: "object",
          properties: { amount: { type: "number" } },
          required: ["amount"],
        },
        handler: write,
      },
    ],
    resources: [
      {
        uri: "expenses://private",
        name: "Private expenses",
        scopes: ["write"],
        async handler() {
          return { contents: [{ uri: "expenses://private", text: "private" }] };
        },
      },
    ],
  });
beforeEach(async () => {
  [signing, issuer, device] = await Promise.all([
    generateEs256KeyPair(),
    generateEs256KeyPair(),
    generateEs256KeyPair(),
  ]);
  write.mockClear();
  options = {
    resource: `${origin}/api`,
    publicOrigin: origin,
    clientId: "cli",
    supportedScopes: ["read", "discover", "write"],
    signingKey: { kid: "local", privateJwk: signing.privateJwk, publicJwk: signing.publicJwk },
    replayStore: inMemory({ suppressWarning: true }),
    mcp: mcp(["read", "discover"]),
  };
  vi.stubGlobal("fetch", async (url: string | URL) =>
    String(url).endsWith("jwks")
      ? Response.json({ keys: [{ ...issuer.publicJwk, kid: "central", use: "sig", alg: "ES256" }] })
      : Response.json({ issuer: host, jwks_uri: `${host}/jwks` }),
  );
});
async function token(scopes: string[], machine = false) {
  if (!machine)
    return issueAccessToken({
      issuer: origin,
      subject: "alice",
      email: "alice@example.com",
      resource: `${origin}/api`,
      clientId: "cli",
      scopes,
      jkt: device.jkt,
      kid: "local",
      privateJwk: signing.privateJwk,
    });
  const now = Math.floor(Date.now() / 1000);
  return signEs256(
    {
      iss: host,
      sub: "machine:automation",
      aud: `${origin}/api`,
      client_id: "automation",
      azp: "automation",
      identity_type: "machine",
      token_type: "machine",
      scope: scopes.join(" "),
      cnf: { jkt: device.jkt },
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    },
    { kid: "central", privateJwk: issuer.privateJwk, typ: MACHINE_TOKEN_TYP },
  );
}
async function request(
  accessToken: string,
  rpc: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      authorization: `DPoP ${accessToken}`,
      dpop: await createDpopProof({ ...device, method: "POST", url: endpoint, accessToken }),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify(rpc),
  });
}
const rpc = (method: string, params = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
async function connected(scopes: string[], machine = false) {
  const weldall = initWeldall(host, options);
  const accessToken = await token(scopes, machine);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: async (url, init) => {
      expect(String(url)).toBe(endpoint);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `DPoP ${accessToken}`);
      headers.set(
        "dpop",
        await createDpopProof({
          ...device,
          method: init?.method ?? "GET",
          url: endpoint,
          accessToken,
        }),
      );
      return weldall.handlers.mcp(new Request(endpoint, { ...init, headers }));
    },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return client;
}

describe("native MCP", () => {
  it("rejects missing, empty, duplicate, invalid, unsupported scopes and disabled replay", () => {
    for (const scopes of [undefined, [], ["read", "read"], ["bad scope"]])
      expect(() => mcp(scopes as string[])).toThrow();
    expect(() => initWeldall(host, { ...options, supportedScopes: ["read"] })).toThrow("scopes");
    expect(() => initWeldall(host, { ...options, replayStore: "disabled" })).toThrow("replay");
  });
  it("advertises immutable versioned metadata only when enabled, independently from skills", async () => {
    const weldall = initWeldall(host, options);
    expect(await weldall.handlers.protectedResourceMetadata().then((r) => r.json())).toMatchObject({
      weldall_mcp: {
        endpoint,
        discoveryScopes: ["discover", "read"],
        schemaVersion: 1,
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const { mcp: _, ...httpOnly } = options;
    expect(
      await initWeldall(host, httpOnly)
        .handlers.protectedResourceMetadata()
        .then((r) => r.json()),
    ).not.toHaveProperty("weldall_mcp");
  });
  it.each(["initialize", "tools/list", "resources/list", "resources/templates/list", "tools/call"])(
    "requires authentication and every discovery scope for %s",
    async (method) => {
      const weldall = initWeldall(host, options);
      expect((await weldall.handlers.mcp(new Request(endpoint, { method: "POST" }))).status).toBe(
        401,
      );
      for (const scopes of [["read"], ["discover"], ["write"]])
        expect(
          (await weldall.handlers.mcp(await request(await token(scopes), rpc(method)))).status,
        ).toBe(403);
    },
  );
  it.each([false, true])(
    "uses the existing verifier and real protocol lifecycle (machine=%s)",
    async (machine) => {
      const client = await connected(["read", "discover"], machine);
      try {
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami", "write"]);
        expect((await client.listTools()).tools[1]).toMatchObject({
          _meta: { "weldall/scopes": ["write"] },
        });
        expect((await client.listResources()).resources).toHaveLength(1);
        expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
        expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
          content: [{ text: machine ? "machine:automation" : "alice" }],
          structuredContent: { identityType: machine ? "machine" : "user" },
        });
        await expect(client.callTool({ name: "write", arguments: { amount: 1 } })).rejects.toThrow(
          "scope",
        );
        await expect(client.readResource({ uri: "expenses://private" })).rejects.toThrow("scope");
        expect(write).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    },
  );
  it("validates arguments before invoking once, and never retries", async () => {
    const client = await connected(["read", "discover", "write"]);
    try {
      await expect(
        client.callTool({ name: "write", arguments: { amount: "bad" } }),
      ).rejects.toThrow("arguments");
      expect(write).not.toHaveBeenCalled();
      expect(await client.callTool({ name: "write", arguments: { amount: 1 } })).toMatchObject({
        content: [{ text: "written" }],
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(await client.readResource({ uri: "expenses://private" })).toMatchObject({
        contents: [{ text: "private" }],
      });
    } finally {
      await client.close();
    }
  });
  it("enforces Draft 2020-12 rules for both input and output", async () => {
    const schema = JSON.parse(
      readFileSync(new URL("./fixtures/native-schema.json", import.meta.url), "utf8"),
    );
    let output: { amount: number; currency?: string } = { amount: 10 };
    const handler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "charged" }],
      structuredContent: output,
    }));
    const weldall = initWeldall(host, {
      ...options,
      mcp: createNativeMcp({
        path: "/api/mcp",
        description: "Schema validation",
        discoveryScopes: ["read"],
        tools: [
          {
            name: "charge",
            scopes: ["write"],
            inputSchema: schema,
            outputSchema: structuredClone(schema),
            handler,
          },
        ],
      }),
    });
    const accessToken = await token(["read", "write"]);
    const call = async (args: unknown) =>
      (
        await weldall.handlers.mcp(
          await request(accessToken, rpc("tools/call", { name: "charge", arguments: args })),
        )
      ).json();
    expect(await call({ amount: 10 })).toMatchObject({ error: { code: -32602 } });
    expect(handler).not.toHaveBeenCalled();
    expect(await call({ amount: 10, currency: "EUR" })).toMatchObject({ error: { code: -32603 } });
    expect(handler).toHaveBeenCalledTimes(1);
    output = { amount: 10, currency: "EUR" };
    expect(await call(output)).toMatchObject({ result: { structuredContent: output } });
    expect(handler).toHaveBeenCalledTimes(2);
  });
  it.each([
    "https://json-schema.org/draft/2099-01/schema",
    "http://json-schema.org/draft-07/schema#",
  ])("rejects unsupported schema dialect %s at declaration time", ($schema) => {
    expect(() =>
      createNativeMcp({
        path: "/api/mcp",
        description: "Schema validation",
        discoveryScopes: ["read"],
        tools: [
          {
            name: "write",
            scopes: ["write"],
            inputSchema: { type: "object", $schema },
            handler: write,
          },
        ],
      }),
    ).toThrow();
  });
  it.each(["inputSchema", "outputSchema"])("rejects asynchronous %s validation", (field) => {
    expect(() =>
      createNativeMcp({
        path: "/api/mcp",
        description: "Schema validation",
        discoveryScopes: ["read"],
        tools: [
          {
            name: "write",
            scopes: ["write"],
            inputSchema: { type: "object" },
            [field]: { type: "object", $async: true },
            handler: write,
          },
        ],
      }),
    ).toThrow("synchronous");
  });
  it("rejects replays, stale revisions, cross-origin browser traffic, and wrong DPoP targets", async () => {
    const weldall = initWeldall(host, options);
    const accessToken = await token(["read", "discover"]);
    const first = await request(accessToken, rpc("tools/list"));
    const replay = first.clone();
    expect((await weldall.handlers.mcp(first)).status).toBe(200);
    expect((await weldall.handlers.mcp(replay)).status).toBe(401);
    expect(
      (
        await weldall.handlers.mcp(
          await request(accessToken, rpc("tools/list"), { "weldall-mcp-revision": "stale" }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await weldall.handlers.mcp(
          await request(accessToken, rpc("tools/list"), { origin: "https://evil.example" }),
        )
      ).status,
    ).toBe(403);
    const wrong = await createDpopProof({
      ...device,
      method: "POST",
      url: `${origin}/api/other`,
      accessToken,
    });
    expect(
      (await weldall.handlers.mcp(await request(accessToken, rpc("tools/list"), { dpop: wrong })))
        .status,
    ).toBe(401);
  });
  it("bounds request bodies and rejects cancelled operations without replay", async () => {
    const normal = initWeldall(host, options);
    const oversized = await request(
      await token(["read", "discover"]),
      rpc("tools/call", {
        name: "whoami",
        arguments: { text: "x".repeat(1024 * 1024) },
      }),
    );
    expect((await normal.handlers.mcp(oversized)).status).toBe(413);
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const weldall = initWeldall(host, {
      ...options,
      mcp: createNativeMcp({
        path: "/api/mcp",
        description: "Cancellation",
        discoveryScopes: ["read"],
        tools: [
          {
            name: "wait",
            scopes: ["read"],
            inputSchema: { type: "object" },
            async handler() {
              started();
              return new Promise(() => {});
            },
          },
        ],
      }),
    });
    const controller = new AbortController();
    const pending = weldall.handlers.mcp(
      new Request(await request(await token(["read"]), rpc("tools/call", { name: "wait" })), {
        signal: controller.signal,
      }),
    );
    await running;
    controller.abort();
    expect((await pending).status).toBe(503);
  }, 2000);
  it("mounts automatically in Hono without changing HTTP authentication", async () => {
    const weldall = initHono(host, options);
    const app = weldall.registerRoutes(new Hono());
    app.get("/api/http", weldall.protect({ scopes: ["read"] }), (c) =>
      c.json({ subject: weldall.getAuth(c).subject }),
    );
    expect(
      (await app.request(await request(await token(["read", "discover"]), rpc("tools/list"))))
        .status,
    ).toBe(200);
    expect((await app.request("/api/http")).status).toBe(401);
  });
});
