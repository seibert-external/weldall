import type { z } from "zod";
import type { mcpCallResultSchema } from "./contracts.js";
import type {
  McpAppDisplayMode,
  McpAppEvent,
  McpAppHost,
  McpAppRequests,
  McpAppNotifications,
} from "./browser-types.js";
export type * from "./browser-types.js";

/** Standard MCP result: content blocks, optional structured data, and tool-level `isError`. */
export type McpAppToolResult = z.output<typeof mcpCallResultSchema>;
type MountState = {
  refs: number;
  release(): void;
  call(name: string, args: Record<string, unknown>): Promise<McpAppToolResult>;
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  host(): Promise<McpAppHost>;
  subscribe(listener: (event: McpAppEvent) => void | Promise<void>): () => void;
};

/**
 * Send a typed standard request through the mounted bridge. No direct network access or retries.
 * @param method Standard request method; the host remains the authorization boundary.
 * @param params Parameters for that method. Requires the relevant advertised host capability.
 * @returns The host result; transport failures, unsupported hosts and timeouts reject.
 */
export async function requestMcpApp<M extends keyof McpAppRequests>(
  method: M,
  params: McpAppRequests[M]["params"],
): Promise<McpAppRequests[M]["result"]> {
  const state = (window as unknown as Record<symbol, MountState | undefined>)[
    Symbol.for("@weldall/mcp/display")
  ];
  if (!state?.request) throw new Error("This host/view does not support MCP App requests");
  return state.request(method, params) as Promise<McpAppRequests[M]["result"]>;
}

/** Read the initialized host's capabilities/context. Waits for initialization; never grants permissions. */
export async function getMcpAppHost(): Promise<McpAppHost> {
  const state = (window as unknown as Record<symbol, MountState | undefined>)[
    Symbol.for("@weldall/mcp/display")
  ];
  if (!state?.host) throw new Error("Mount a current MCP App bootstrap first");
  return state.host();
}

/**
 * Observe host tool inputs/results, context changes and teardown. Replays the latest received values.
 * @param listener Called for each event; failures are isolated. Teardown acknowledgment waits for
 * returned promises, subject to the host's shutdown deadline (Goose: two seconds).
 * @returns Idempotent unsubscribe. All listeners are removed on teardown.
 */
export function subscribeMcpAppEvents(
  listener: (event: McpAppEvent) => void | Promise<void>,
): () => void {
  const state = (window as unknown as Record<symbol, MountState | undefined>)[
    Symbol.for("@weldall/mcp/display")
  ];
  if (!state?.subscribe) throw new Error("Mount a current MCP App bootstrap first");
  return state.subscribe(listener);
}

/**
 * Send a standard fire-and-forget notification. Resolving means sent, not accepted by the host.
 * @param method Logging, manual size reporting, or a request for host-managed teardown.
 * @param params Standard notification parameters.
 */
export async function notifyMcpApp<M extends keyof McpAppNotifications>(
  method: M,
  params: McpAppNotifications[M],
): Promise<void> {
  const state = (window as unknown as Record<symbol, MountState | undefined>)[
    Symbol.for("@weldall/mcp/display")
  ];
  if (!state?.notify) throw new Error("This host/view does not support MCP App notifications");
  return state.notify(method, params);
}

/** Send a diagnostic log to the host, not the chat. Do not include credentials or sensitive data. */
export function sendMcpAppLog(params: McpAppNotifications["notifications/message"]): Promise<void> {
  return notifyMcpApp("notifications/message", params);
}

/** Ask the host to close this app. The host decides whether/when to send resource-teardown. */
export function requestMcpAppTeardown(): Promise<void> {
  return notifyMcpApp("ui/notifications/request-teardown", {});
}

/**
 * Read a content URI from this view's own MCP server, using the user's existing authorization.
 * @param params Original upstream `uri` from `listMcpAppResources`, not a host-prefixed URI.
 * @returns The host response; unsupported capabilities, protocol errors and timeouts reject. Never retries.
 */
export function readMcpAppResource(
  params: McpAppRequests["resources/read"]["params"],
): Promise<McpAppRequests["resources/read"]["result"]> {
  return requestMcpApp("resources/read", params);
}

/**
 * List this view's own MCP resources. Defaults to the first page; cursors are host-specific.
 * @param params Standard MCP Apps request parameters; defaults to an empty object.
 * @returns The host response; unsupported capabilities, protocol errors and timeouts reject. Never retries.
 */
export function listMcpAppResources(
  params: McpAppRequests["resources/list"]["params"] = {},
): Promise<McpAppRequests["resources/list"]["result"]> {
  return requestMcpApp("resources/list", params);
}

/**
 * Send an explicit user message to the chat and request a model response. Tool calls alone do not do this.
 * The model may use any tools available to the chat, not just the view's allowlisted tools.
 * @param params `role: "user"` and MCP content blocks. Check host capabilities for supported modalities.
 * @returns The host response; unsupported capabilities, protocol errors and timeouts reject. Never retries.
 */
export function sendMcpAppMessage(
  params: McpAppRequests["ui/message"]["params"],
): Promise<McpAppRequests["ui/message"]["result"]> {
  return requestMcpApp("ui/message", params);
}

/**
 * Replace this app's context for future model turns without sending a chat message or starting a turn.
 * @param params Optional MCP `content` blocks and/or `structuredContent`. Each update replaces, not merges.
 * @returns The host response; unsupported capabilities, protocol errors and timeouts reject. Never retries.
 */
export function updateMcpAppContext(
  params: McpAppRequests["ui/update-model-context"]["params"],
): Promise<McpAppRequests["ui/update-model-context"]["result"]> {
  return requestMcpApp("ui/update-model-context", params);
}

/**
 * Ask the host to open a URL. The host may prompt or refuse; check the returned isError.
 * @param params Standard MCP Apps request parameters.
 * @returns The host response; unsupported capabilities, protocol errors and timeouts reject. Never retries.
 */
export function openMcpAppLink(
  params: McpAppRequests["ui/open-link"]["params"],
): Promise<McpAppRequests["ui/open-link"]["result"]> {
  return requestMcpApp("ui/open-link", params);
}

/**
 * Ask the host to save embedded contents or an authorized resource link. Check isError for cancellation.
 * @param params `contents` of embedded text/base64 resources or own-server resource links. No direct HTTP fetching.
 * @returns The host response; unsupported capabilities, protocol errors and timeouts reject. Never retries.
 */
export function downloadMcpAppFile(
  params: McpAppRequests["ui/download-file"]["params"],
): Promise<McpAppRequests["ui/download-file"]["result"]> {
  return requestMcpApp("ui/download-file", params);
}

/**
 * Request a display mode and return the actual accepted mode, which may differ from the request.
 * @param params Standard MCP Apps request parameters.
 * @returns The host response; unsupported capabilities, protocol errors and timeouts reject. Never retries.
 */
export function requestMcpAppDisplayMode(
  params: McpAppRequests["ui/request-display-mode"]["params"],
): Promise<McpAppRequests["ui/request-display-mode"]["result"]> {
  return requestMcpApp("ui/request-display-mode", params);
}

/**
 * Request a model completion only on hosts advertising sampling. This is not a chat message.
 * @param params Standard MCP Apps request parameters.
 * @returns The host response; unsupported capabilities, protocol errors and timeouts reject. Never retries.
 */
export function createMcpAppSamplingMessage(
  params: McpAppRequests["sampling/createMessage"]["params"],
): Promise<McpAppRequests["sampling/createMessage"]["result"]> {
  return requestMcpApp("sampling/createMessage", params);
}

/**
 * Call an explicitly allowed tool of this view's own registered resource through the host.
 * Requires the HTML bootstrap or `mountMcpApp`. Waits for initialization; rejects on unsupported
 * hosts, protocol errors, timeout or teardown. Tool failures are returned as `result.isError`.
 * No automatic retries: after a timeout the operation may already have completed.
 * @param name Original tool name from the resource catalog, not a Goose-prefixed name.
 * @param args JSON arguments matching that tool's input schema. Defaults to an empty object.
 * @returns The MCP result, including `isError` for tool-level failures; transport failures reject.
 */
export async function callMcpAppTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpAppToolResult> {
  const state = (window as unknown as Record<symbol, MountState | undefined>)[
    Symbol.for("@weldall/mcp/display")
  ];
  if (!state) throw new Error("Mount the MCP App before calling tools");
  if (typeof state.call !== "function")
    throw new Error("This host/view does not support resource-bound tool calls");
  return state.call(name, args);
}

/** Shared options for HTML resource creation, bootstrap rendering and browser mounting. */
export interface McpAppDisplayOptions {
  /**
   * Modes offered to the host, not an automatic mode switch. Defaults to `["inline"]`, which
   * must always be included. Add `fullscreen` and/or `pip` for supporting hosts' controls.
   * PiP presentation is host-specific; Goose uses a floating panel, not a separate OS window.
   */
  displayModes?: readonly McpAppDisplayMode[];
  /**
   * Public, non-sensitive ES module URLs on `resourceOrigin` (e.g. a bundled React entrypoint).
   * Defaults to none. Modules need correct MIME/CORS headers and load only after the host
   * confirms a compatible Weldall bridge. No provider inline scripts, CDN modules or API fetching.
   */
  scriptUrls?: readonly string[];
  /**
   * Exact registered resource origin, e.g. `https://expenses.example.com` (no path/trailing slash).
   * Required when loading assets; omit for asset-free HTML. HTTPS only, except HTTP loopback
   * for development. The extension independently verifies it against the resource registration.
   */
  resourceOrigin?: string | undefined;
}

/**
 * Mount the browser-side MCP App lifecycle: initialize the host bridge, report changing content
 * height in inline mode, follow host theme/mode changes and handle teardown. Does not render UI
 * or grant tool permissions; use `callMcpAppTool` for allowed calls. Mount after `document.body` exists, not during SSR.
 * @param options Display modes and optional same-origin modules. The first mount owns configuration;
 * subsequent mounts share it, including an existing HTML bootstrap from `createMcpAppResource`.
 * @returns An idempotent cleanup function; the last release removes observers and listeners.
 * @example
 * useEffect(() => mountMcpApp({ displayModes: ["inline", "fullscreen", "pip"] }), []);
 */
export function mountMcpApp(options: McpAppDisplayOptions = {}): () => void {
  // Keep self-contained: the server embeds this function's compiled source in HTML.
  const modes = [...new Set(options.displayModes ?? ["inline"])];
  if (
    !modes.includes("inline") ||
    modes.some((mode) => !["inline", "fullscreen", "pip"].includes(mode))
  )
    throw new Error("Invalid MCP App display modes");
  const scripts = [...(options.scriptUrls ?? [])];
  if (
    scripts.some((src) => {
      const url = new URL(src);
      return (
        url.origin !== options.resourceOrigin ||
        url.username ||
        url.password ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      );
    })
  )
    throw new Error("MCP App scripts must use the resource origin");

  // The HTML bootstrap and a framework effect may share one document/handshake.
  const key = Symbol.for("@weldall/mcp/display");
  const registry = window as unknown as Record<symbol, MountState | undefined>;
  const existing = registry[key];
  if (existing) {
    existing.refs++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        existing.release();
      }
    };
  }
  const id = `weldall-ui-${crypto.randomUUID()}`;
  let initialized = false;
  let closed = false;
  let frame = 0;
  let lastHeight = 0;
  let mode = "inline";
  let toolCalls = false;
  const host: McpAppHost = { capabilities: {}, context: {} };
  const listeners = new Set<(event: McpAppEvent) => void | Promise<void>>();
  const latest = new Map<string, McpAppEvent>();
  const emit = async (event: McpAppEvent) => {
    latest.set(event.method, event);
    await Promise.all(
      [...listeners].map(async (listener) => {
        try {
          await listener(event);
        } catch (error) {
          console.error("MCP App event listener failed", error);
        }
      }),
    );
  };
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: number; method: string }
  >();
  let sequence = 0;
  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const measure = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // Body's natural height, not the viewport's minimum height: permit shrinking too.
      const style = getComputedStyle(document.body);
      const height = Math.ceil(
        Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height) +
          (parseFloat(style.marginTop) || 0) +
          (parseFloat(style.marginBottom) || 0),
      );
      if (initialized && !closed && mode === "inline" && height > 0 && height !== lastHeight) {
        lastHeight = height;
        post({ method: "ui/notifications/size-changed", params: { height } });
      }
    });
  };
  const observer = new ResizeObserver(measure);
  const context = (value: { displayMode?: string; theme?: string } | undefined) => {
    Object.assign(host.context, value);
    if (value?.displayMode) mode = value.displayMode;
    if (value?.theme === "light" || value?.theme === "dark")
      document.documentElement.style.colorScheme = value.theme;
    lastHeight = 0;
    measure();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    cancelAnimationFrame(frame);
    observer.disconnect();
    const error = new Error(
      "MCP App closed; pending operations may have completed. Do not retry automatically.",
    );
    rejectReady(error);
    listeners.clear();
    latest.clear();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    window.removeEventListener("message", receive);
    window.removeEventListener("pagehide", cleanup);
    if (registry[key] === state) delete registry[key];
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || closed || !event.data || event.data.jsonrpc !== "2.0")
      return;
    const message = event.data;
    if (message.id === id && !initialized) {
      clearTimeout(timeout);
      if (message.error || !message.result?.hostContext) {
        cleanup();
        return;
      }
      initialized = true;
      host.capabilities = message.result.hostCapabilities ?? {};
      toolCalls =
        message.result.hostCapabilities?.experimental?.["weldall/resource-tool-calls"]?.version ===
        1;
      context(message.result.hostContext);
      post({ method: "ui/notifications/initialized" });
      resolveReady();
      emit({ method: "ui/notifications/host-context-changed", params: { ...host.context } });
      observer.observe(document.body);
      observer.observe(document.documentElement);
      measure();
      // Fail closed on older hosts: assets must not gain access to an unrestricted bridge.
      if (
        scripts.length &&
        !toolCalls &&
        message.result.hostCapabilities?.experimental?.["weldall/display-only"]?.version !== 1 &&
        message.result.hostCapabilities?.experimental?.["weldall/app-bridge"]?.version !== 1
      ) {
        console.error(
          "Weldall: this host does not support a compatible MCP Apps bridge. Scripts were not loaded.",
        );
        return;
      }
      for (const src of scripts) {
        const script = document.createElement("script");
        script.type = "module";
        script.src = src;
        document.body.appendChild(script);
      }
    } else if (typeof message.id === "string" && pending.has(message.id) && !message.method) {
      const request = pending.get(message.id)!;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error)
        request.reject(new Error("MCP App request failed; do not retry automatically"));
      else if (
        !message.result ||
        typeof message.result !== "object" ||
        Array.isArray(message.result) ||
        (request.method === "tools/call" && !Array.isArray(message.result.content)) ||
        (request.method === "resources/read" && !Array.isArray(message.result.contents)) ||
        (request.method === "resources/list" && !Array.isArray(message.result.resources)) ||
        (request.method === "ui/request-display-mode" &&
          !["inline", "fullscreen", "pip"].includes(message.result.mode))
      )
        request.reject(new Error("Invalid MCP App result"));
      else request.resolve(message.result);
    } else if (initialized && message.method === "ui/notifications/host-context-changed") {
      context(message.params);
      emit({ method: "ui/notifications/host-context-changed", params: { ...host.context } });
    } else if (
      initialized &&
      [
        "ui/notifications/tool-input",
        "ui/notifications/tool-input-partial",
        "ui/notifications/tool-result",
        "ui/notifications/tool-cancelled",
      ].includes(message.method)
    ) {
      if (message.method === "ui/notifications/tool-input")
        latest.delete("ui/notifications/tool-input-partial");
      emit({ method: message.method, params: message.params ?? {} } as McpAppEvent);
    } else if (message.method === "ui/resource-teardown" && message.id !== undefined) {
      void emit({ method: "ui/resource-teardown", params: message.params ?? {} }).then(() => {
        post({ id: message.id, result: {} });
        cleanup();
      });
    }
  };
  const state: MountState = {
    refs: 1,
    async call(name, args) {
      await ready;
      if (closed || !toolCalls)
        throw new Error("This host/view does not support resource-bound tool calls");
      if (
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name) ||
        !args ||
        Array.isArray(args) ||
        typeof args !== "object"
      )
        throw new Error("Invalid tool name or arguments");
      return state.request("tools/call", { name, arguments: args }) as Promise<McpAppToolResult>;
    },
    async host() {
      await ready;
      if (closed) throw new Error("MCP App closed");
      return structuredClone(host);
    },
    subscribe(listener) {
      if (closed) throw new Error("MCP App closed");
      listeners.add(listener);
      for (const event of latest.values()) {
        try {
          void Promise.resolve(listener(event)).catch((error) =>
            console.error("MCP App event listener failed", error),
          );
        } catch (error) {
          console.error("MCP App event listener failed", error);
        }
      }
      return () => {
        listeners.delete(listener);
      };
    },
    async notify(method, params) {
      await ready;
      if (closed) throw new Error("MCP App closed");
      if (method === "notifications/message" && !host.capabilities.logging)
        throw new Error("This host does not support logging");
      if (
        ![
          "notifications/message",
          "ui/notifications/size-changed",
          "ui/notifications/request-teardown",
        ].includes(method)
      )
        throw new Error("Unsupported MCP App notification");
      if (new TextEncoder().encode(JSON.stringify(params)).length > 1024 * 1024)
        throw new Error("MCP App request limit exceeded");
      post({ method, params });
    },
    async request(method, params) {
      if (!initialized) await ready;
      if (closed) throw new Error("MCP App closed; pending operations may have completed");
      const capabilities: Record<string, boolean> = {
        "tools/call": toolCalls,
        "resources/read": Boolean(toolCalls && host.capabilities.serverResources),
        "resources/list": Boolean(toolCalls && host.capabilities.serverResources),
        "ui/message": Boolean(host.capabilities.message),
        "ui/update-model-context": Boolean(host.capabilities.updateModelContext),
        "ui/open-link": Boolean(host.capabilities.openLinks),
        "ui/download-file": Boolean(host.capabilities.downloadFile),
        "ui/request-display-mode": true,
        "sampling/createMessage": Boolean(host.capabilities.sampling),
      };
      if (!Object.hasOwn(capabilities, method) || !capabilities[method])
        throw new Error(`This host/view does not support ${method}`);
      if (
        pending.size >= 16 ||
        new TextEncoder().encode(JSON.stringify(params)).length > 1024 * 1024
      )
        throw new Error("MCP App request limit exceeded");
      const requestId = `${id}-call-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(requestId);
          reject(
            new Error(
              "MCP App request timed out; it may have completed. Do not retry automatically.",
            ),
          );
        }, 30_000);
        pending.set(requestId, { resolve, reject, timer, method });
        try {
          post({ method, id: requestId, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error);
        }
      });
    },
    release: () => {
      if (--state.refs === 0) cleanup();
    },
  };
  registry[key] = state;
  const timeout = window.setTimeout(cleanup, 10_000);
  window.addEventListener("message", receive);
  window.addEventListener("pagehide", cleanup);
  post({
    method: "ui/initialize",
    id,
    params: {
      appInfo: { name: "Weldall resource", version: "1.0.0" },
      appCapabilities: { availableDisplayModes: modes },
      protocolVersion: "2026-01-26",
    },
  });
  let released = false;
  return () => {
    if (!released) {
      released = true;
      state.release();
    }
  };
}
