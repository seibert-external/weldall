import { describe, expect, it, vi } from "vitest";
import { McpBoundaryError } from "@weldall/sdk/mcp";
import type { AuthorizedConnectionUse } from "../src/server/connectors/core/authorization";
import {
  createMemoryMcpToolCache,
  toolCatalogKey,
  type McpToolCache,
  type ToolCatalog,
} from "../src/server/mcp/tool-cache";

const catalog: ToolCatalog = {
  tools: [{ name: "read", description: "ä", inputSchema: { type: "object" } }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function request(
  cache: McpToolCache,
  overrides: Partial<Parameters<McpToolCache["getOrLoad"]>[0]> = {},
) {
  return cache.getOrLoad({
    key: "one",
    signal: new AbortController().signal,
    load: async () => catalog,
    onStatus: () => {},
    ...overrides,
  });
}

describe("bounded process-local MCP tool catalog cache", () => {
  it("expires five minutes after publication, not loading or last use; snapshots are isolated", async () => {
    let now = 0;
    const cache = createMemoryMcpToolCache({ now: () => now });
    const pending = deferred<ToolCatalog>();
    const loading = request(cache, { load: () => pending.promise });
    now = 1000;
    pending.resolve(structuredClone(catalog));
    const first = await loading;
    first.tools[0]!.name = "mutated";
    now = 300_999;
    const load = vi.fn(async () => catalog);
    const onStatus = vi.fn();
    expect(await request(cache, { load, onStatus })).toEqual(catalog);
    expect(onStatus).toHaveBeenLastCalledWith("hit");
    expect(load).not.toHaveBeenCalled();
    now = 301_000;
    await request(cache, { load, onStatus });
    expect(onStatus).toHaveBeenLastCalledWith("miss");
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(["entries", "bytes"] as const)(
    "evicts least recently used catalogs at the %s bound",
    async (bound) => {
      const cache = createMemoryMcpToolCache(
        bound === "entries"
          ? { maxEntries: 2 }
          : { maxBytes: 2 * Buffer.byteLength(JSON.stringify(catalog), "utf8") },
      );
      const load = vi.fn(async () => catalog);
      for (const key of ["a", "b", "a", "c", "a"]) await request(cache, { key, load });
      expect(load).toHaveBeenCalledTimes(3);
      await request(cache, { key: "b", load });
      expect(load).toHaveBeenCalledTimes(4);
    },
  );

  it("does not retain a catalog larger than its byte budget", async () => {
    const cache = createMemoryMcpToolCache({ maxBytes: 1 });
    const load = vi.fn(async () => catalog);
    await request(cache, { load });
    await request(cache, { load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces misses without sharing mutable return values", async () => {
    const cache = createMemoryMcpToolCache();
    const pending = deferred<ToolCatalog>();
    const load = vi.fn(() => pending.promise);
    const statuses = vi.fn();
    const a = request(cache, { load, onStatus: statuses });
    const b = request(cache, { load, onStatus: statuses });
    pending.resolve(catalog);
    const [first, second] = await Promise.all([a, b]);
    expect(load).toHaveBeenCalledOnce();
    expect(statuses.mock.calls).toEqual([["miss"], ["coalesced"]]);
    first.tools.length = 0;
    expect(second).toEqual(catalog);
  });

  it.each([0, 1])("cancelling waiter %i does not cancel another waiter", async (index) => {
    const cache = createMemoryMcpToolCache();
    const pending = deferred<ToolCatalog>();
    const controllers = [new AbortController(), new AbortController()];
    const load = vi.fn((signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return pending.promise;
    });
    const calls = controllers.map(({ signal }) => request(cache, { signal, load }));
    const rejected = expect(calls[index]).rejects.toMatchObject({ code: "cancelled" });
    controllers[index]!.abort();
    await rejected;
    expect(load.mock.calls[0]![0].aborted).toBe(false);
    pending.resolve(catalog);
    expect(await calls[1 - index]).toEqual(catalog);
    expect(load).toHaveBeenCalledOnce();
    const status = vi.fn();
    await request(cache, { onStatus: status });
    expect(status).toHaveBeenCalledWith("hit");
  });

  it("aborts abandoned work, does not publish it, and cannot delete a replacement flight", async () => {
    const cache = createMemoryMcpToolCache();
    const pending = deferred<ToolCatalog>();
    const controller = new AbortController();
    const load = vi.fn(() => pending.promise);
    const first = request(cache, { load, signal: controller.signal });
    await Promise.resolve();
    const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await rejected;
    const replacement = deferred<ToolCatalog>();
    const secondLoad = vi.fn(() => replacement.promise);
    const second = request(cache, { load: secondLoad });
    pending.resolve(catalog);
    await new Promise((resolve) => setImmediate(resolve));
    const third = request(cache, { load: secondLoad });
    replacement.resolve(catalog);
    await Promise.all([second, third]);
    expect(secondLoad).toHaveBeenCalledOnce();
  });

  it("bounds in-flight work, including abandoned work until it settles", async () => {
    const cache = createMemoryMcpToolCache({ maxInFlight: 1 });
    const pending = deferred<ToolCatalog>();
    const controller = new AbortController();
    const first = request(cache, { signal: controller.signal, load: () => pending.promise });
    await Promise.resolve();
    await expect(request(cache, { key: "two" })).rejects.toMatchObject({ code: "rate_limit" });
    const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await rejected;
    await expect(request(cache)).rejects.toMatchObject({ code: "rate_limit" });
    pending.resolve(catalog);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(request(cache)).resolves.toEqual(catalog);
  });

  it("never caches failures or serves expired data after a failed refresh", async () => {
    let now = 0;
    const cache = createMemoryMcpToolCache({ now: () => now, ttlMs: 1 });
    await request(cache);
    now = 1;
    const pending = deferred<ToolCatalog>();
    const load = vi.fn(() => pending.promise);
    const calls = [request(cache, { load }), request(cache, { load })];
    const results = Promise.allSettled(calls);
    pending.reject(new McpBoundaryError("upstream_protocol_error"));
    expect((await results).every((r) => r.status === "rejected")).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    const onStatus = vi.fn();
    await request(cache, { onStatus });
    expect(onStatus).toHaveBeenCalledWith("miss");
  });

  it("rejects already cancelled hits and misses without loading", async () => {
    const cache = createMemoryMcpToolCache();
    await request(cache);
    const load = vi.fn();
    for (const key of ["one", "two"])
      await expect(
        request(cache, { key, load, signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: "cancelled" });
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects invalid bounds", () => {
    for (const value of [0, -1, NaN, Infinity, 0.5])
      for (const bound of ["ttlMs", "maxBytes", "maxEntries", "maxInFlight"])
        expect(() => createMemoryMcpToolCache({ [bound]: value })).toThrow(
          "Invalid MCP cache bound",
        );
  });
});

describe("catalog identity", () => {
  const connection = {
    row: {
      id: "connection",
      version: 1,
      connectorId: "connector",
      credentialId: "credential",
      connector: { version: 1 },
    },
    grant: { scopes: ["read"], cloudId: "site" },
  } as unknown as AuthorizedConnectionUse;
  it("isolates connections, connector/config versions, credential versions/identities and grants", () => {
    const original = toolCatalogKey(connection);
    for (const row of [
      { ...connection.row, id: "another" },
      { ...connection.row, connectorId: "another" },
      { ...connection.row, version: 2 },
      { ...connection.row, connector: { ...connection.row.connector, version: 2 } },
      { ...connection.row, credentialId: "rotated" },
    ])
      expect(toolCatalogKey({ ...connection, row })).not.toBe(original);
    expect(
      toolCatalogKey({ ...connection, grant: { ...connection.grant, scopes: ["write"] } }),
    ).not.toBe(original);
  });
  it("ignores usage timestamps, counters, request IDs and actor identity", () => {
    expect(
      toolCatalogKey({
        ...connection,
        row: { ...connection.row, updatedAt: new Date(), requestCount: 10 },
        actor: { id: "other", requestId: "next", scopeKeys: [] },
      }),
    ).toBe(toolCatalogKey(connection));
  });
});
