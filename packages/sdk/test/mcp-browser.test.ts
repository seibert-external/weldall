import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderMcpAppBootstrapHtml } from "../src/mcp/display.js";
import * as browser from "../src/mcp/browser.js";
import { callMcpAppTool, type McpAppDisplayOptions } from "../src/mcp/browser.js";

function fixture(options: McpAppDisplayOptions = {}) {
  const html = renderMcpAppBootstrapHtml(options);
  const config = html.match(/data-weldall-mcp="display">([\s\S]*?)<\/script>/)![1]!;
  const code = html.match(/<script>([\s\S]*)<\/script>$/)![1]!;
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const frames = new Map<number, () => void>();
  const scripts: Record<string, unknown>[] = [];
  let counter = 0;
  let resize!: () => void;
  const disconnect = vi.fn();
  const parent = { postMessage: vi.fn() };
  const body = {
    scrollHeight: 330,
    getBoundingClientRect: () => ({ height: body.scrollHeight }),
    appendChild: (script: Record<string, unknown>) => scripts.push(script),
  };
  const document = {
    body,
    documentElement: { style: { colorScheme: "" } },
    currentScript: { previousElementSibling: { textContent: config } },
    createElement: () => ({}),
  };
  const window = {
    parent,
    setTimeout: vi.fn((_callback: () => void, _delay: number) => 1),
    addEventListener(name: string, handler: (event: unknown) => void) {
      const group = listeners.get(name) ?? new Set();
      group.add(handler);
      listeners.set(name, group);
    },
    removeEventListener(name: string, handler: (event: unknown) => void) {
      listeners.get(name)?.delete(handler);
    },
  };
  const globals = {
    window,
    document,
    URL,
    TextEncoder,
    structuredClone,
    console: { error: vi.fn() },
    crypto: { randomUUID: () => "test" },
    clearTimeout: vi.fn(),
    getComputedStyle: () => ({ marginTop: "8px", marginBottom: "8px" }),
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++counter, callback);
      return counter;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
    ResizeObserver: class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  };
  const context = createContext(globals);
  const cleanup = runInContext(code, context) as () => void;
  const api = Object.fromEntries(
    Object.entries(browser).map(([name, fn]) => {
      const evaluated = runInContext(`(${fn.toString()})`, context);
      Object.assign(context, { [name]: evaluated });
      return [name, evaluated];
    }),
  ) as typeof browser;
  const send = (data: unknown, source: unknown = parent) => {
    for (const callback of listeners.get("message") ?? []) callback({ data, source });
  };
  const initialize = (trusted = true) =>
    send({
      jsonrpc: "2.0",
      id: "weldall-ui-test",
      result: {
        hostContext: { displayMode: "inline", theme: "dark" },
        hostCapabilities: trusted
          ? { experimental: { "weldall/display-only": { version: 1 } } }
          : {},
      },
    });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  };
  return {
    parent,
    api,
    body,
    scripts,
    document,
    send,
    initialize,
    flush,
    disconnect,
    cleanup,
    listeners,
    context,
    code,
    call: runInContext(`(${callMcpAppTool.toString()})`, context) as typeof callMcpAppTool,
    timeouts: window.setTimeout,
    resize: () => resize(),
  };
}

describe("framework-independent MCP display lifecycle", () => {
  const enableCalls = (f: ReturnType<typeof fixture>) =>
    f.send({
      jsonrpc: "2.0",
      id: "weldall-ui-test",
      result: {
        hostContext: {},
        hostCapabilities: { experimental: { "weldall/resource-tool-calls": { version: 1 } } },
      },
    });
  it("waits for the bound host, correlates results, rejects spoofed messages and never retries", async () => {
    const f = fixture();
    const promise = f.call("approve", { id: 1 });
    await Promise.resolve();
    expect(f.parent.postMessage).toHaveBeenCalledOnce();
    enableCalls(f);
    await Promise.resolve();
    const sent = f.parent.postMessage.mock.calls.at(-1)![0];
    expect(sent).toMatchObject({
      method: "tools/call",
      params: { name: "approve", arguments: { id: 1 } },
    });
    const resolved = vi.fn();
    void promise.then(resolved);
    f.send({ jsonrpc: "2.0", id: sent.id, result: { content: [] } }, {});
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    const result = { content: [], structuredContent: { approved: true }, isError: false };
    f.send({ jsonrpc: "2.0", id: sent.id, result });
    await expect(promise).resolves.toEqual(result);
    const failed = f.call("approve");
    await Promise.resolve();
    const last = f.parent.postMessage.mock.calls.at(-1)![0];
    f.send({ jsonrpc: "2.0", id: last.id, error: { code: -32602, message: "Denied" } });
    await expect(failed).rejects.toThrow("do not retry");
    expect(f.parent.postMessage.mock.calls.filter(([m]) => m.method === "tools/call")).toHaveLength(
      2,
    );
    f.cleanup();
  });
  it("fails closed on display-only/older hosts and rejects pending calls on teardown", async () => {
    const old = fixture();
    old.initialize();
    await expect(old.call("approve")).rejects.toThrow("does not support");
    expect(old.parent.postMessage.mock.calls.some(([m]) => m.method === "tools/call")).toBe(false);
    old.cleanup();
    const f = fixture();
    enableCalls(f);
    const promise = f.call("approve");
    await Promise.resolve();
    f.cleanup();
    await expect(promise).rejects.toThrow("may have completed");
  });
  it("loads modules with the resource-bound capability and returns tool-level errors intact", async () => {
    const f = fixture({
      resourceOrigin: "https://expenses.example",
      scriptUrls: ["https://expenses.example/app.js"],
    });
    enableCalls(f);
    expect(f.scripts).toHaveLength(1);
    const promise = f.call("approve");
    await Promise.resolve();
    f.send({
      jsonrpc: "2.0",
      id: f.parent.postMessage.mock.calls.at(-1)![0].id,
      result: { content: [], isError: true },
    });
    await expect(promise).resolves.toMatchObject({ isError: true });
    await expect(f.call("foreign__invalid tool")).rejects.toThrow("Invalid tool");
    f.cleanup();
  });
  it("bounds in-flight calls and times out without replay", async () => {
    const f = fixture();
    enableCalls(f);
    const calls = Array.from({ length: 16 }, () => f.call("approve"));
    const settled = Promise.allSettled(calls);
    await Promise.resolve();
    await expect(f.call("approve")).rejects.toThrow("request limit");
    expect(f.parent.postMessage.mock.calls.filter(([m]) => m.method === "tools/call")).toHaveLength(
      16,
    );
    const timeout = f.timeouts.mock.calls.find(([, delay]) => delay === 30_000)![0];
    timeout();
    f.cleanup();
    const results = await settled;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(results[0]).toMatchObject({ reason: { message: expect.stringContaining("timed out") } });
    expect(f.parent.postMessage.mock.calls.filter(([m]) => m.method === "tools/call")).toHaveLength(
      16,
    );
  });

  it("exposes host capabilities, standard requests, notifications and replayed host events", async () => {
    const f = fixture({
      resourceOrigin: "https://expenses.example",
      scriptUrls: ["https://expenses.example/app.js"],
    });
    f.send({
      jsonrpc: "2.0",
      id: "weldall-ui-test",
      result: {
        hostContext: { theme: "light", displayMode: "inline" },
        hostCapabilities: {
          experimental: {
            "weldall/app-bridge": { version: 1 },
            "weldall/resource-tool-calls": { version: 1 },
          },
          serverResources: {},
          message: { text: {} },
          updateModelContext: { text: {} },
          openLinks: {},
          downloadFile: {},
          logging: {},
        },
      },
    });
    expect(f.scripts).toHaveLength(1);
    expect(await f.api.getMcpAppHost()).toMatchObject({
      context: { theme: "light" },
      capabilities: { message: { text: {} } },
    });
    f.send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { count: 1 } },
    });
    const events = vi.fn();
    const unsubscribe = f.api.subscribeMcpAppEvents(events);
    expect(events).toHaveBeenCalledWith({
      method: "ui/notifications/tool-result",
      params: { structuredContent: { count: 1 } },
    });
    const cases = [
      [
        () => f.api.readMcpAppResource({ uri: "demo://current" }),
        "resources/read",
        { contents: [{ uri: "demo://current", blob: "aGk=" }] },
      ],
      [() => f.api.listMcpAppResources(), "resources/list", { resources: [] }],
      [
        () =>
          f.api.sendMcpAppMessage({ role: "user", content: [{ type: "text", text: "Continue" }] }),
        "ui/message",
        {},
      ],
      [
        () => f.api.updateMcpAppContext({ structuredContent: { count: 1 } }),
        "ui/update-model-context",
        {},
      ],
      [
        () => f.api.openMcpAppLink({ url: "https://example.com" }),
        "ui/open-link",
        { isError: true },
      ],
      [
        () =>
          f.api.downloadMcpAppFile({
            contents: [
              { type: "resource", resource: { uri: "file:///report.txt", text: "Report" } },
            ],
          }),
        "ui/download-file",
        { isError: false },
      ],
      [
        () => f.api.requestMcpAppDisplayMode({ mode: "fullscreen" }),
        "ui/request-display-mode",
        { mode: "fullscreen" },
      ],
    ] as const;
    for (const [call, method, result] of cases) {
      const promise = call();
      await Promise.resolve();
      const request = f.parent.postMessage.mock.calls.at(-1)![0];
      expect(request.method).toBe(method);
      f.send({ jsonrpc: "2.0", id: request.id, result });
      await expect(promise).resolves.toEqual(result);
    }
    await expect(
      f.api.createMcpAppSamplingMessage({ messages: [], maxTokens: 10 }),
    ).rejects.toThrow("does not support");
    await f.api.sendMcpAppLog({ level: "info", data: "Ready" });
    expect(f.parent.postMessage.mock.calls.at(-1)![0]).toMatchObject({
      method: "notifications/message",
    });
    unsubscribe();
    f.send({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: {} });
    expect(events).toHaveBeenCalledTimes(2);
    await f.api.requestMcpAppTeardown();
    expect(f.parent.postMessage.mock.calls.at(-1)![0]).toMatchObject({
      method: "ui/notifications/request-teardown",
    });
    f.cleanup();
    await expect(f.api.getMcpAppHost()).rejects.toThrow();
  });

  it("acknowledges teardown after async cleanup and clears all listeners", async () => {
    const f = fixture();
    f.initialize();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.api.subscribeMcpAppEvents((event) =>
      event.method === "ui/resource-teardown" ? done : undefined,
    );
    f.send({ jsonrpc: "2.0", id: "close", method: "ui/resource-teardown", params: {} });
    expect(f.parent.postMessage.mock.calls.some(([m]) => m.id === "close")).toBe(false);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.parent.postMessage.mock.calls.at(-1)![0]).toEqual({
      jsonrpc: "2.0",
      id: "close",
      result: {},
    });
    expect(f.listeners.get("message")?.size).toBe(0);
  });

  it("negotiates modes and resizes after content changes, including shrink", () => {
    const f = fixture({ displayModes: ["inline", "fullscreen", "pip"] });
    expect(f.parent.postMessage.mock.calls[0]![0]).toMatchObject({
      method: "ui/initialize",
      params: { appCapabilities: { availableDisplayModes: ["inline", "fullscreen", "pip"] } },
    });
    f.initialize();
    f.flush();
    expect(f.parent.postMessage.mock.calls.at(-1)![0]).toMatchObject({
      method: "ui/notifications/size-changed",
      params: { height: 346 },
    });
    f.body.scrollHeight = 150;
    f.resize();
    f.flush();
    expect(f.parent.postMessage.mock.calls.at(-1)![0].params.height).toBe(166);
    f.send({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    const count = f.parent.postMessage.mock.calls.length;
    f.flush();
    expect(f.parent.postMessage.mock.calls).toHaveLength(count);
    f.send({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "inline" },
    });
    f.flush();
    expect(f.parent.postMessage.mock.calls).toHaveLength(count + 1);
    f.cleanup();
    expect(f.disconnect).toHaveBeenCalledOnce();
  });

  it("loads same-origin modules only after the host confirms enforcement", () => {
    const f = fixture({
      resourceOrigin: "https://expenses.example",
      scriptUrls: ["https://expenses.example/react.js"],
    });
    expect(f.scripts).toEqual([]);
    f.send(
      {
        jsonrpc: "2.0",
        id: "weldall-ui-test",
        result: {
          hostContext: {},
          hostCapabilities: { experimental: { "weldall/display-only": { version: 1 } } },
        },
      },
      {},
    );
    expect(f.scripts).toEqual([]);
    f.initialize();
    expect(f.scripts).toEqual([{ type: "module", src: "https://expenses.example/react.js" }]);
    f.initialize();
    expect(f.scripts).toHaveLength(1);
    f.cleanup();
  });

  it("keeps older hosts on the trusted bootstrap without loading resource code", () => {
    const f = fixture({
      resourceOrigin: "https://expenses.example",
      scriptUrls: ["https://expenses.example/react.js"],
    });
    f.initialize(false);
    f.flush();
    expect(f.scripts).toEqual([]);
    expect(f.parent.postMessage.mock.calls.at(-1)![0].method).toBe("ui/notifications/size-changed");
    f.cleanup();
  });

  it("shares a handshake with React effects and tears down after the last cleanup", () => {
    const f = fixture();
    const effectCleanup = runInContext(f.code, f.context) as () => void;
    expect(f.parent.postMessage).toHaveBeenCalledOnce();
    effectCleanup();
    effectCleanup();
    expect(f.disconnect).not.toHaveBeenCalled();
    f.cleanup();
    f.cleanup();
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.listeners.get("message")?.size).toBe(0);
    const remount = runInContext(f.code, f.context) as () => void;
    expect(f.parent.postMessage).toHaveBeenCalledTimes(2);
    remount();
  });
});
