import type { AstroIntegration } from "astro";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndexFromDir, writeIndexFile } from "./indexing.js";
import { DEFAULTS, normalizeSearchPath, toPersistedConfig } from "./options.js";
import type { WeldallSearchOptions } from "./types.js";

export { configureRuntimeOptions as configureWeldallSearchRuntime } from "./runtime.js";
export type { SearchHit, WeldallSearchOptions, WeldallSearchRuntimeOptions } from "./types.js";

/**
 * Resolves the file path of one of this package's injected route entrypoints.
 * The routes are shipped in `dist/starlight/routes/` and referenced by absolute
 * path so the consuming Astro app bundles them without extra wiring.
 *
 * @param name - Route module name without the `.js` extension.
 * @returns Absolute file path to the built route module.
 */
const routeEntrypoint = (name: string): string =>
  fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));

/**
 * Starlight integration that exposes a Weldall-SDK-authenticated full-text
 * search endpoint (`/api/search` by default) over the site's own MDX content.
 *
 * The interface mirrors `initWeldall(host, options)` from `@weldall/sdk`:
 * `host` is the Weldall authorization-server origin and `options` use the same
 * names and shapes as the SDK for deployable config (`resource`,
 * `publicOrigin`, `clientId`, ...). The search endpoint requires all of the
 * configured `requiredScopes`. The auto-discovered `search` skill title is
 * derived from the site origin.
 *
 * At build time the integration indexes `src/content/docs` with Orama into
 * `.weldall-search/index.json` and injects four routes:
 *
 * - `GET /api/search?q=…` — the protected search endpoint
 * - `GET /.well-known/oauth-protected-resource` — resource metadata
 * - `GET /.well-known/oauth-protected-resource/api` — per-path metadata
 * - `GET /.well-known/weldall-skills` — skill catalog (auto-discovery)
 *
 * **Requires SSR.** Set `output: "server"` and a server adapter (e.g.
 * `@astrojs/node`) in `astro.config.mjs`, or the integration throws.
 *
 * **Optional peer dependencies.** Orama and gray-matter are loaded lazily and
 * must be installed in the consuming site when the search path is used:
 *
 * ```sh
 * pnpm add @orama/orama @orama/stemmers @orama/stopwords gray-matter
 * ```
 *
 * @example
 * ```js
 * weldallSearch("https://weldall.example.com", {
 *   publicOrigin: "https://basics.seibert.tools",
 *   resource: "https://basics.seibert.tools/api",
 *   clientId: "weldall-cli-at-basics",
 *   requiredScopes: ["search:read"],
 * })
 * ```
 *
 * @param host - The Weldall platform authorization-server origin (the SDK's
 *   `host` argument). Also readable from `WELDALL_ISSUER` at runtime.
 * @param options - Weldall SDK options plus site-specific keys; all optional
 *   because they can come from `WELDALL_*` environment variables at runtime.
 * @returns An Astro integration ready for the `integrations` array.
 */
export function weldallSearch(host: string, options: WeldallSearchOptions = {}): AstroIntegration {
  const searchPath = normalizeSearchPath(options.searchPath ?? DEFAULTS.searchPath);
  const language = options.language ?? DEFAULTS.language;
  const contentDir = options.contentDir ?? DEFAULTS.contentDir;
  const persisted = toPersistedConfig(options, host);
  let projectRoot = "";

  return {
    name: "@weldall/sdk/starlight",
    hooks: {
      /**
       * Validates SSR, builds the Orama index from the content directory,
       * persists the non-secret configuration, and injects the search,
       * resource-metadata, and skill-catalog routes.
       */
      "astro:config:setup": async ({ config, injectRoute, logger }) => {
        if (config.output !== "server") {
          throw new Error(
            "@weldall/sdk/starlight requires SSR. " +
              'Set `output: "server"` and a server adapter (e.g. @astrojs/node) in astro.config.mjs.',
          );
        }
        if (options.skills && "load" in options.skills) {
          throw new Error(
            "@weldall/sdk/starlight does not support dynamic skill loaders; pass skills.items instead.",
          );
        }
        projectRoot = fileURLToPath(config.root);

        const indexDir = path.join(projectRoot, ".weldall-search");
        const indexFile = path.join(indexDir, "index.json");
        const content = path.join(projectRoot, contentDir);
        const built = await buildIndexFromDir(content, language);
        await writeIndexFile(indexFile, { language, raw: built.raw });
        await mkdir(indexDir, { recursive: true });
        await writeFile(path.join(indexDir, "config.json"), JSON.stringify(persisted, null, 2));
        logger.info(
          `@weldall/sdk/starlight: indexed ${built.documents.length} documents into ${indexFile}`,
        );

        injectRoute({ pattern: searchPath, entrypoint: routeEntrypoint("search") });
        injectRoute({
          pattern: "/.well-known/oauth-protected-resource",
          entrypoint: routeEntrypoint("oauth-protected-resource"),
        });
        injectRoute({
          pattern: "/.well-known/oauth-protected-resource/api",
          entrypoint: routeEntrypoint("oauth-protected-resource-api"),
        });
        injectRoute({
          pattern: "/.well-known/weldall-skills",
          entrypoint: routeEntrypoint("skills"),
        });
      },
      /**
       * Copies the generated index and configuration into the build output so
       * the deployed artifact stays self-contained.
       */
      "astro:build:done": async ({ dir, logger }) => {
        if (!projectRoot) return;
        const sourceDir = path.join(projectRoot, ".weldall-search");
        const targetDir = fileURLToPath(new URL(".weldall-search/", dir));
        await mkdir(targetDir, { recursive: true });
        for (const name of ["index.json", "config.json"] as const) {
          const source = path.join(sourceDir, name);
          await copyFile(source, path.join(targetDir, name));
        }
        logger.info("@weldall/sdk/starlight: copied search index into build output");
      },
    },
  };
}
