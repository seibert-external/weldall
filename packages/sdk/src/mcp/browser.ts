/** Host presentation: embedded (`inline`), expanded (`fullscreen`), or floating panel (`pip`). */
export type McpAppDisplayMode = "inline" | "fullscreen" | "pip";

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
   * confirms its display-only bridge guard. No inline scripts, CDN modules or API fetching.
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
 * or expose business-tool calls. Call in the browser after `document.body` exists, not during SSR.
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
  const registry = window as unknown as Record<
    symbol,
    { refs: number; release: () => void } | undefined
  >;
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
      context(message.result.hostContext);
      post({ method: "ui/notifications/initialized" });
      observer.observe(document.body);
      observer.observe(document.documentElement);
      measure();
      // Fail closed on older hosts: assets must not gain access to an unrestricted bridge.
      if (
        scripts.length &&
        message.result.hostCapabilities?.experimental?.["weldall/display-only"]?.version !== 1
      ) {
        console.error(
          "Weldall: this host does not support display-only JavaScript. Scripts were not loaded.",
        );
        return;
      }
      for (const src of scripts) {
        const script = document.createElement("script");
        script.type = "module";
        script.src = src;
        document.body.appendChild(script);
      }
    } else if (initialized && message.method === "ui/notifications/host-context-changed") {
      context(message.params);
    } else if (message.method === "ui/resource-teardown" && message.id !== undefined) {
      post({ id: message.id, result: {} });
      cleanup();
    }
  };
  const state = {
    refs: 1,
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
