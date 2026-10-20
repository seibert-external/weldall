import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeMcpCatalogCache, nativeMcpCatalogCache } from "../src/storage/native-mcp-cache.js";
import {
  generateEs256KeyPair,
  initWeldall,
  inMemory,
  issueIdJag,
  type ResourceRegistryEntry,
} from "@weldall/sdk";
import { createNativeMcp, createMcpAppResource } from "@weldall/sdk/mcp/server";
import type { WeldallConfig } from "../src/config.js";
import { requestNativeMcp, resolveNativeMcp } from "../src/services/native-mcp.js";
import { discoverNativeResources } from "../src/services/discovery.js";

const state = vi.hoisted(() => ({ session: null as any }));
vi.mock("../src/services/auth.js", () => ({
  withAccess: async (_: unknown, run: (session: unknown) => Promise<unknown>) => run(state.session),
}));
vi.mock("../src/oauth/session.js", () => ({
  validateIdJagResponse: async (_: unknown, exchange: { issued_token: string }) =>
    exchange.issued_token,
}));
const host = "https://weldall.example";
const origin = "https://expenses.example";
const config = {
  issuer: host,
  scopes: `${host}/api/me/scopes`,
  grants: `${host}/api/me/grants`,
  token: `${host}/token`,
} as WeldallConfig;
let resource: ResourceRegistryEntry;
let instance: ReturnType<typeof initWeldall>;
let metadata: Record<string, unknown>;
let fetched: { url: string; method: string; body?: string }[];
let called: number;
let corruptResult: boolean;
let cacheDirectory: string;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(cacheDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), "native-mcp-test-"));
  const cache = new NativeMcpCatalogCache(cacheDirectory);
  vi.spyOn(nativeMcpCatalogCache, "read").mockImplementation(cache.read.bind(cache));
  vi.spyOn(nativeMcpCatalogCache, "write").mockImplementation(cache.write.bind(cache));
  vi.spyOn(nativeMcpCatalogCache, "remove").mockImplementation(cache.remove.bind(cache));
  const [signing, issuer, device] = await Promise.all([
    generateEs256KeyPair(),
    generateEs256KeyPair(),
    generateEs256KeyPair(),
  ]);
  state.session = {
    subject: "alice",
    accessToken: "central-token",
    credentials: { ...device, refreshToken: "refresh" },
  };
  called = 0;
  fetched = [];
  corruptResult = false;
  resource = {
    key: "expenses",
    name: "Expenses",
    resourceIdentifier: `${origin}/api`,
    authorizationServer: origin,
    downstreamClientId: "cli",
    requestPrefixes: [`${origin}/api`],
    supportedScopes: ["read", "write"],
    grantedScopes: ["read", "write"],
  };
  const ui = createMcpAppResource({
    name: "expenses",
    scopes: ["read"],
    allowedTools: ["write"],
    resourceOrigin: origin,
    styleUrls: [`${origin}/ui.css`],
    render: ({ auth }) => `<h1>${auth.subject}</h1>`,
  });
  instance = initWeldall(host, {
    resource: resource.resourceIdentifier,
    publicOrigin: origin,
    clientId: "cli",
    supportedScopes: resource.supportedScopes,
    signingKey: { kid: "local", ...signing },
    replayStore: inMemory({ suppressWarning: true }),
    mcp: createNativeMcp({
      path: "/api/mcp",
      description: "Expenses",
      discoveryScopes: ["read"],
      tools: [
        {
          name: "write",
          _meta: { ui: { resourceUri: ui.uri } },
          scopes: ["write"],
          inputSchema: { type: "object" },
          async handler(_, { auth }) {
            called++;
            return { content: [{ type: "text", text: auth.subject }] };
          },
        },
      ],
      resources: [
        ui,
        {
          name: "Expenses",
          uri: "expenses://current",
          scopes: ["read"],
          async handler() {
            return { contents: [{ uri: "expenses://current", text: "expenses" }] };
          },
        },
      ],
    }),
  });
  metadata = await instance.handlers.protectedResourceMetadata().then((r) => r.json());
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    expect(init?.redirect).toBe("error");
    fetched.push({
      url: target,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: String(init.body) } : {}),
    });
    if (target === `${host}/.well-known/oauth-authorization-server`)
      return Response.json({ issuer: host, jwks_uri: `${host}/jwks` });
    if (target === `${host}/jwks`)
      return Response.json({
        keys: [{ ...issuer.publicJwk, kid: "central", alg: "ES256", use: "sig" }],
      });
    if (target === config.grants) return Response.json(resource.grantedScopes);
    if (target === config.scopes) return Response.json([resource]);
    if (target === `${origin}/.well-known/oauth-protected-resource`) return Response.json(metadata);
    if (target === config.token) {
      const scopes = new URLSearchParams(String(init?.body)).get("scope")!.split(" ");
      return Response.json({
        issued_token: await issueIdJag({
          issuer: host,
          subject: state.session.subject,
          email: `${state.session.subject}@example.com`,
          audience: origin,
          clientId: "cli",
          resource: resource.resourceIdentifier,
          scopes,
          jkt: device.jkt,
          kid: "central",
          privateJwk: issuer.privateJwk,
        }),
      });
    }
    if (target === `${origin}/oauth/token`)
      return instance.handlers.token(new Request(target, init));
    if (target === `${origin}/api/mcp`) {
      const response = await instance.handlers.mcp(new Request(target, init));
      if (corruptResult && String(init?.body).includes('"tools/call"'))
        return new Response("broken", { status: 502 });
      return response;
    }
    throw new Error(`Unexpected URL: ${target}`);
  });
});

describe("native CLI resource transport", () => {
  it("lists, calls once with the exact declared scopes, and reads resources using normal DPoP auth", async () => {
    expect(await requestNativeMcp(config, "tools", { resourceKey: "expenses" })).toMatchObject({
      tools: [{ name: "write" }],
    });
    expect(
      await requestNativeMcp(config, "call", { resourceKey: "expenses", name: "write" }),
    ).toMatchObject({ content: [{ text: "alice" }] });
    expect(called).toBe(1);
    const exchanges = fetched.filter((r) => r.url === config.token);
    expect(exchanges.map((r) => new URLSearchParams(r.body).get("scope"))).toEqual([
      "read",
      "read write",
    ]);
    expect(
      await requestNativeMcp(config, "read-resource", {
        resourceKey: "expenses",
        uri: "expenses://current",
      }),
    ).toMatchObject({ contents: [{ text: "expenses" }] });
    expect(fetched.some((r) => r.url.includes("connectors"))).toBe(false);
  });
  it("preserves native UI metadata through discovery, disk cache and direct authenticated HTML reads", async () => {
    const discovered = await discoverNativeResources(config, { resources: ["expenses"] });
    expect(discovered.results[0]).toMatchObject({
      tools: [{ _meta: { ui: { resourceUri: "ui://weldall/expenses" } } }],
      resources: expect.arrayContaining([
        {
          name: "expenses",
          uri: "ui://weldall/expenses",
          mimeType: "text/html;profile=mcp-app",
          _meta: { ui: { allowedTools: ["write"] } },
        },
      ]),
    });
    fetched = [];
    expect(await requestNativeMcp(config, "tools", { resourceKey: "expenses" })).toMatchObject({
      tools: [
        { _meta: { ui: { resourceUri: "ui://weldall/expenses" }, "weldall/scopes": ["write"] } },
      ],
    });
    expect(fetched.some((request) => request.body?.includes('"tools/list"'))).toBe(false);
    const result = await requestNativeMcp(config, "read-resource", {
      resourceKey: "expenses",
      uri: "ui://weldall/expenses",
    });
    expect(result).toMatchObject({
      contents: [
        {
          text: expect.stringContaining("<h1>alice</h1>"),
          _meta: { ui: { csp: { resourceDomains: [origin] } } },
        },
      ],
    });
    expect(fetched.some((request) => request.url.includes("connectors"))).toBe(false);
    expect(
      fetched
        .filter((request) => request.body?.includes('"resources/read"'))
        .map((request) => request.url),
    ).toEqual([`${origin}/api/mcp`]);
  });

  it("reuses definitions but checks metadata, grants and operation tokens on every call", async () => {
    await requestNativeMcp(config, "tools", { resourceKey: "expenses" });
    fetched = [];
    await requestNativeMcp(config, "call", { resourceKey: "expenses", name: "write" });
    expect(fetched.some((r) => r.body?.includes('"tools/list"'))).toBe(false);
    expect(fetched.some((r) => r.url.endsWith("/.well-known/oauth-protected-resource"))).toBe(true);
    expect(fetched.some((r) => r.url === config.scopes)).toBe(true);
    expect(fetched.filter((r) => r.url === config.token)).toHaveLength(1);
    resource.grantedScopes = ["read"];
    await expect(
      requestNativeMcp(config, "call", { resourceKey: "expenses", name: "write" }),
    ).rejects.toThrow();
    expect(called).toBe(1);
  });
  it("revalidates corrupt disk catalogs instead of treating them as authority", async () => {
    await requestNativeMcp(config, "tools", { resourceKey: "expenses" });
    const key = vi.mocked(nativeMcpCatalogCache.read).mock.calls[0]![0];
    await nativeMcpCatalogCache.write(key, { tools: [{ name: "unsafe" }], resources: [] });
    fetched = [];
    expect(await requestNativeMcp(config, "tools", { resourceKey: "expenses" })).toMatchObject({
      tools: [{ name: "write" }],
    });
    expect(fetched.some((r) => r.body?.includes('"tools/list"'))).toBe(true);
  });
  it("never uses a warmed catalog after discovery permission is revoked", async () => {
    await requestNativeMcp(config, "tools", { resourceKey: "expenses" });
    resource.grantedScopes = [];
    fetched = [];
    vi.mocked(nativeMcpCatalogCache.read).mockClear();
    await expect(requestNativeMcp(config, "tools", { resourceKey: "expenses" })).rejects.toThrow();
    expect(nativeMcpCatalogCache.read).not.toHaveBeenCalled();
    expect(fetched.some((r) => r.url === config.token || r.url.endsWith("/api/mcp"))).toBe(false);
  });
  it.each(["subject", "revision", "registration"] as const)(
    "does not reuse a catalog across a changed %s",
    async (change) => {
      await requestNativeMcp(config, "tools", { resourceKey: "expenses" });
      const previous = vi.mocked(nativeMcpCatalogCache.read).mock.calls.at(-1)![0];
      if (change === "subject") state.session.subject = "bob";
      if (change === "revision")
        (metadata.weldall_mcp as Record<string, unknown>).revision = "b".repeat(64);
      if (change === "registration") resource.downstreamClientId = "changed-client";
      fetched = [];
      const request = requestNativeMcp(config, "tools", { resourceKey: "expenses" });
      if (change !== "revision") {
        await expect(request).resolves.toHaveProperty("tools");
        expect(fetched.some((r) => r.body?.includes('"tools/list"'))).toBe(true);
      } else {
        // The fixture endpoint still advertises the old revision.
        await expect(request).rejects.toThrow();
      }
      expect(vi.mocked(nativeMcpCatalogCache.read).mock.calls.at(-1)![0]).not.toBe(previous);
    },
  );
  it("invalidates cached definitions on a stale endpoint revision without replaying", async () => {
    await requestNativeMcp(config, "tools", { resourceKey: "expenses" });
    const fetcher = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url) === `${origin}/api/mcp`)
        return Response.json({ error: "stale_mcp_catalog" }, { status: 409 });
      return fetcher(url, init);
    });
    await expect(
      requestNativeMcp(config, "call", { resourceKey: "expenses", name: "write" }),
    ).rejects.toThrow();
    expect(called).toBe(0);
    expect(nativeMcpCatalogCache.remove).toHaveBeenCalledOnce();
    vi.stubGlobal("fetch", fetcher);
    fetched = [];
    await requestNativeMcp(config, "tools", { resourceKey: "expenses" });
    expect(fetched.some((r) => r.body?.includes('"tools/list"'))).toBe(true);
  });
  it("does not invoke or retry when the operation grant is missing", async () => {
    resource.grantedScopes = ["read"];
    await expect(
      requestNativeMcp(config, "call", { resourceKey: "expenses", name: "write" }),
    ).rejects.toThrow("denied");
    expect(called).toBe(0);
    expect(fetched.filter((r) => r.url === config.token)).toHaveLength(1);
  });
  it("does not fetch definitions or mint tokens without every discovery grant", async () => {
    resource.grantedScopes = [];
    await expect(requestNativeMcp(config, "tools", { resourceKey: "expenses" })).rejects.toThrow(
      "denied",
    );
    expect(fetched.some((r) => r.url === config.token || r.url.endsWith("/api/mcp"))).toBe(false);
  });
  it.each([
    "https://evil.example/api/mcp",
    `${origin}/mcp`,
    `${origin}/api/mcp?token=x`,
    `${origin}/api/%6dcp`,
  ])("rejects untrusted endpoint %s before sending credentials", async (endpoint) => {
    (metadata.weldall_mcp as Record<string, unknown>).endpoint = endpoint;
    await expect(resolveNativeMcp(config, "expenses", AbortSignal.timeout(1000))).rejects.toThrow();
    expect(fetched.some((r) => r.url === config.token)).toBe(false);
  });
  it("does not replay a completed write when its response is lost", async () => {
    corruptResult = true;
    await expect(
      requestNativeMcp(config, "call", { resourceKey: "expenses", name: "write" }),
    ).rejects.toThrow("may already have completed");
    expect(called).toBe(1);
  });
  it("cancels oversized HTTP error bodies without replaying a completed write", async () => {
    const fetcher = globalThis.fetch;
    let bytes = 0;
    let cancelled = false;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const response = await fetcher(url, init);
      if (String(url) !== `${origin}/api/mcp` || !String(init?.body).includes('"tools/call"'))
        return response;
      await response.body?.cancel();
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (bytes === 20 * 1024 * 1024) return controller.close();
            const chunk = new Uint8Array(64 * 1024).fill(120);
            bytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      );
    });
    await expect(
      requestNativeMcp(config, "call", { resourceKey: "expenses", name: "write" }),
    ).rejects.toThrow("may already have completed");
    expect(called).toBe(1);
    expect(cancelled).toBe(true);
    expect(bytes).toBeLessThanOrEqual(128 * 1024);
  });
  it("rejects a resource without native advertisement (old server/HTTP-only compatibility)", async () => {
    delete metadata.weldall_mcp;
    await expect(resolveNativeMcp(config, "expenses", AbortSignal.timeout(1000))).rejects.toThrow(
      "compatible native MCP",
    );
    expect(fetched.some((r) => r.url === config.token)).toBe(false);
  });
  it("loads a bounded deduplicated batch, preserving success beside an unavailable source", async () => {
    const result = await discoverNativeResources(config, {
      resources: ["expenses", "missing", "expenses"],
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      issuer: host,
      subject: "alice",
      results: [
        { kind: "resource", key: "expenses", status: "resolved", tools: [{ name: "write" }] },
        { kind: "resource", key: "missing", status: "unavailable", code: "source_unavailable" },
      ],
    });
    expect(fetched.filter((r) => r.url === config.token)).toHaveLength(1);
  });
  it("catalog-only loads descriptions without schemas or token exchange", async () => {
    const result = await discoverNativeResources(config, {
      resources: ["expenses"],
      catalogOnly: true,
    });
    expect(result.results).toEqual([
      {
        kind: "resource",
        id: "resource:expenses",
        direct: true,
        viaSkills: [],
        key: "expenses",
        name: "Expenses",
        description: "Expenses",
        status: "catalog",
      },
    ]);
    expect(fetched.some((r) => r.url === config.token || r.url.endsWith("/api/mcp"))).toBe(false);
  });
  it.each([
    { expectedIssuer: "https://elsewhere.example" },
    { expectedSubject: "bob" },
    { expectedRevision: "0".repeat(64) },
    { expectedResourceIdentifier: "https://evil.example/api" },
  ])("refuses incompatible session routing before execution: %j", async (guard) => {
    await expect(
      requestNativeMcp(config, "call", { resourceKey: "expenses", name: "write", ...guard }),
    ).rejects.toThrow();
    expect(called).toBe(0);
    expect(fetched.some((r) => r.url === config.token)).toBe(false);
  });
  it("cancels before any network request", async () => {
    await expect(
      requestNativeMcp(config, "tools", { resourceKey: "expenses" }, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fetched).toEqual([]);
  });
});
