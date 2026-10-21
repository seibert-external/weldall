import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { MCP_LIMITS, assertMcpJson } from "./contracts.js";
import { MCP_APP_MIME_TYPE, mcpAppAssetUrlSchema, mcpAppOriginSchema } from "./apps.js";
import { mountMcpApp, type McpAppDisplayOptions } from "./browser.js";
import { nativeMcpScopesSchema, nativeMcpResourceDefinitionSchema } from "./native.js";
import type { NativeMcpContext, NativeMcpResource } from "./server.js";

/**
 * Escape plain text for an HTML text node or a quoted attribute value.
 * @param value Untrusted text, such as a caller name. Not an HTML fragment, URL, CSS or JavaScript.
 * @returns Text with HTML metacharacters escaped; interpolate it into the rendered markup.
 */
export const escapeMcpAppText = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const displayOptionsSchema = z
  .object({
    displayModes: z
      .array(z.enum(["inline", "fullscreen", "pip"]))
      .min(1)
      .max(3)
      .refine((modes) => modes.includes("inline"))
      .default(["inline"]),
    resourceOrigin: mcpAppOriginSchema.optional(),
    scriptUrls: z.array(mcpAppAssetUrlSchema).max(16).default([]),
  })
  .refine(
    (options) => options.scriptUrls.every((url) => new URL(url).origin === options.resourceOrigin),
    "Scripts must use the resource origin",
  );

const bootstrapCode = () =>
  `(${mountMcpApp.toString()})(JSON.parse(document.currentScript.previousElementSibling.textContent));`;

/**
 * Render the HTML fragment that initializes sizing, display modes and the host lifecycle.
 * Append it before `</body>` in a custom native UI resource. This returns a string; it does
 * not modify a document. {@link createMcpAppResource} already includes it automatically.
 * @param options Display modes and optional public, same-origin ES modules.
 * @returns Configuration and bootstrap script tags. Resource modules load only after the host
 * confirms a compatible Weldall bridge; unsupported hosts keep static content.
 */
export function renderMcpAppBootstrapHtml(options: McpAppDisplayOptions = {}): string {
  const config = JSON.stringify(displayOptionsSchema.parse(options)).replace(/</g, "\\u003c");
  return `<script type="application/json" data-weldall-mcp="display">${config}</script><script>${bootstrapCode()}</script>`;
}

/**
 * Rebuild a native UI document with sanitized markup, a restricted CSP and the SDK bootstrap.
 * Removes provider inline scripts, event handlers, forms and undeclared external assets.
 * This is not the host-side authorization check: the host must enforce resource-bound access.
 * @param html Provider HTML, optionally containing a display bootstrap or external ES module tags.
 * @param resourceOrigin Trusted registered origin (scheme + host + port), never provider-declared
 * CSP. Omit to disallow external assets. HTTPS is required except for explicit loopback hosts.
 * @param connectDomains Origins the app may contact with fetch, XHR or WebSocket. Defaults to none.
 * @param objectDomains Origins the app may embed with `<object>`, for example a PDF. Defaults to none.
 * Treat every allowed origin as a data disclosure boundary.
 * @returns A complete HTML document ready for the host's sandboxed MCP App renderer.
 */
export function sanitizeMcpDisplayHtml(
  html: string,
  resourceOrigin?: string,
  connectDomains: readonly string[] = [],
  objectDomains: readonly string[] = [],
): string {
  assertMcpJson(html);
  const origin =
    resourceOrigin === undefined ? undefined : mcpAppOriginSchema.parse(resourceOrigin);
  const connections = z.array(mcpAppOriginSchema).max(16).parse(connectDomains);
  const objects = z.array(mcpAppOriginSchema).max(16).parse(objectDomains);
  let displayModes: McpAppDisplayOptions["displayModes"] = ["inline"];
  const scripts = new Set<string>();
  const allowedUrl = (value: string | undefined, origins: readonly string[]) => {
    const parsed = mcpAppAssetUrlSchema.safeParse(value);
    return parsed.success && origins.includes(new URL(parsed.data).origin)
      ? parsed.data
      : undefined;
  };
  const asset = (value: string | undefined) =>
    allowedUrl(value, origin === undefined ? [] : [origin]);
  const body = sanitizeHtml(html, {
    // Scripts are parsed solely to extract module URLs/config, then ALL are removed below.
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "link", "img", "object", "script"],
    allowVulnerableTags: true,
    allowedAttributes: {
      "*": ["id", "class", "title", "lang", "dir", "role", "aria-*", "data-*"],
      th: ["scope", "colspan", "rowspan"],
      td: ["colspan", "rowspan"],
      link: ["rel", "href"],
      img: ["src", "alt", "width", "height"],
      object: ["data", "type", "width", "height"],
      script: ["src", "type", "data-weldall-mcp"],
    },
    allowedSchemes: ["https", "http"],
    allowProtocolRelative: false,
    nestingLimit: 64,
    transformTags: {
      link: (_tag, attrs) => ({
        tagName: "link",
        attribs:
          attrs.rel === "stylesheet" && asset(attrs.href)
            ? { rel: "stylesheet", href: asset(attrs.href)! }
            : {},
      }),
      img: (_tag, attrs) => ({
        tagName: "img",
        attribs: asset(attrs.src) ? { ...attrs, src: asset(attrs.src)! } : {},
      }),
      object: (_tag, attrs) => ({
        tagName: "object",
        attribs: allowedUrl(attrs.data, objects)
          ? { ...attrs, data: allowedUrl(attrs.data, objects)! }
          : {},
      }),
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "script") {
        if (frame.attribs.type === "module" && asset(frame.attribs.src))
          scripts.add(asset(frame.attribs.src)!);
        if (
          frame.attribs.type === "application/json" &&
          frame.attribs["data-weldall-mcp"] === "display"
        ) {
          try {
            const parsed = displayOptionsSchema.safeParse(JSON.parse(frame.text));
            if (parsed.success) {
              displayModes = parsed.data.displayModes;
              for (const src of parsed.data.scriptUrls) if (asset(src)) scripts.add(src);
            }
          } catch {
            /* Untrusted configuration is not executable. */
          }
        }
        return true;
      }
      return (
        (frame.tag === "link" && !frame.attribs.href) ||
        (frame.tag === "img" && !frame.attribs.src) ||
        (frame.tag === "object" && !frame.attribs.data)
      );
    },
  });
  const hash = createHash("sha256").update(bootstrapCode()).digest("base64");
  const assets = origin ?? "'none'";
  const connects = connections.length ? connections.join(" ") : "'none'";
  const objectSources = objects.length ? objects.join(" ") : "'none'";
  const csp =
    `default-src 'none'; script-src 'sha256-${hash}'${origin ? ` ${origin}` : ""}; ` +
    `connect-src ${connects}; frame-src 'none'; object-src ${objectSources}; base-uri 'none'; form-action 'none'; ` +
    `style-src 'unsafe-inline'${origin ? ` ${origin}` : ""}; img-src ${assets}; font-src ${assets}`;
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeMcpAppText(csp)}"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${body}${renderMcpAppBootstrapHtml({ displayModes, ...(origin ? { resourceOrigin: origin } : {}), scriptUrls: [...scripts] })}</body></html>`;
  assertMcpJson(document, MCP_LIMITS.resultBytes);
  return document;
}

/**
 * Create an authenticated HTML view with optional same-resource tool calls for a native MCP tool.
 * Add it to `createNativeMcp({ resources: [view], ... })` and link the tool with
 * `_meta: { ui: { resourceUri: view.uri } }`. Creation alone does not register an endpoint.
 * @param options Resource identity, required scopes, renderer and optional display/assets settings.
 * @returns A resource with a generated `ui://weldall/<name>` URI, HTML MIME type and read handler.
 * Each read sanitizes the rendered HTML and adds the sizing/display bootstrap automatically.
 */
export function createMcpAppResource(
  options: McpAppDisplayOptions & {
    /** Stable URI suffix: 1–100 letters, digits, `_` or `-`, starting with a letter or digit. */
    name: string;
    /** Nonempty list of scopes ALL required to read this view, in addition to discovery scopes. */
    scopes: readonly string[];
    /** Original names of tools in this same catalog that this view may call. Defaults to none.
     * This grants no scopes; the current caller must still be authorized for each operation. */
    allowedTools?: readonly string[];
    /** Public stylesheet URLs on `resourceOrigin`; absolute URLs, no credentials or CDN origins. */
    styleUrls?: readonly string[];
    /** Origins this view may contact with fetch, XHR or WebSocket. Defaults to none.
     * Each origin is also declared to the host and must use HTTPS or explicit loopback HTTP. */
    connectDomains?: readonly string[];
    /** Origins this view may embed with `<object>`, for example a PDF. Defaults to none. */
    objectDomains?: readonly string[];
    /**
     * Render an HTML fragment for each authenticated resource read. Escape interpolated text
     * with `escapeMcpAppText`. Receives no preceding tool arguments/results; load data using
     * `context.auth`, enforce record-level access and honor `context.signal` for cancellation.
     */
    render(context: NativeMcpContext): string | Promise<string>;
  },
): NativeMcpResource & { uri: string } {
  const name = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/)
    .parse(options.name);
  const scopes = nativeMcpScopesSchema.parse(options.scopes);
  const config = displayOptionsSchema.parse(options);
  const styles = z
    .array(mcpAppAssetUrlSchema)
    .max(16)
    .parse(options.styleUrls ?? []);
  const connectDomains = z
    .array(mcpAppOriginSchema)
    .max(16)
    .parse(options.connectDomains ?? []);
  const objectDomains = z
    .array(mcpAppOriginSchema)
    .max(16)
    .parse(options.objectDomains ?? []);
  if (styles.some((url) => new URL(url).origin !== config.resourceOrigin))
    throw new TypeError("Stylesheets must use the resource origin");
  const ui = nativeMcpResourceDefinitionSchema.shape._meta.unwrap().parse({
    ui: { allowedTools: options.allowedTools ?? [] },
  }).ui!;
  const uri = `ui://weldall/${name}`;
  const links = styles
    .map((url) => `<link rel="stylesheet" href="${escapeMcpAppText(url)}">`)
    .join("");
  return {
    name,
    uri,
    mimeType: MCP_APP_MIME_TYPE,
    scopes,
    ...(ui.allowedTools.length ? { _meta: { ui } } : {}),
    async handler(context) {
      return {
        contents: [
          {
            uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: sanitizeMcpDisplayHtml(
              links + (await options.render(context)) + renderMcpAppBootstrapHtml(config),
              config.resourceOrigin,
              connectDomains,
              objectDomains,
            ),
            _meta: {
              ui: {
                csp: {
                  resourceDomains: [
                    ...new Set([
                      ...(config.resourceOrigin ? [config.resourceOrigin] : []),
                      ...objectDomains,
                    ]),
                  ],
                  connectDomains,
                },
                prefersBorder: true,
              },
            },
          },
        ],
      };
    },
  };
}
