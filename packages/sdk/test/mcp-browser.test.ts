import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderMcpAppBootstrapHtml } from "../src/mcp/display.js";
import type { McpAppDisplayOptions } from "../src/mcp/browser.js";

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
    setTimeout: vi.fn(() => 1),
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
    resize: () => resize(),
  };
}

describe("framework-independent MCP display lifecycle", () => {
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
