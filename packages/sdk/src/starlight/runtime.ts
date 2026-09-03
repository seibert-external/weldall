import { inMemory } from "../index.js";
import { initWeldall, type AstroWeldall } from "../astro.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readIndexFile, runSearch } from "./indexing.js";
import { DEFAULTS, normalizeSearchPath, type PersistedConfig } from "./options.js";
import { buildSearchSkill } from "./skill.js";
import type { SearchLanguage } from "./languages.js";
import type { DirectSigningKey, ReplayStore } from "../types.js";
import type { SearchHit, WeldallSearchRuntimeOptions } from "./types.js";

const CONFIG_FILE = "config.json";
const INDEX_FILE = "index.json";

/**
 * Fully resolved runtime configuration, read from the persisted
 * `.weldall-search/config.json` written at build time.
 */
export interface RuntimeConfig {
  /** Weldall authorization-server origin. */
  issuer: string;
  /** Resource URL registered in Weldall. */
  resource: string;
  /** Public origin of the site. */
  publicOrigin: string;
  /** Accepted OAuth client id. */
  clientId: string;
  /** Scopes required to search. */
  requiredScopes: readonly string[];
  /** Search endpoint path. */
  searchPath: string;
  /** Search language used for stemming and stop-word removal. */
  language: SearchLanguage;
  /** Default maximum results per query. */
  defaultLimit: number;
  /** Authorization-server discovery timeout in milliseconds. */
  discoveryTimeoutMs?: number;
  /** Origin used to proxy authorization-server discovery. */
  discoveryProxyOrigin?: string;
  /** Whether `http://` loopback origins are allowed. */
  allowInsecureLoopback: boolean;
}

type RuntimeOnlyOptions = {
  replayStore?: ReplayStore | "disabled";
};

let runtimeOnlyOptions: RuntimeOnlyOptions = {};

export function configureRuntimeOptions(options: WeldallSearchRuntimeOptions): void {
  runtimeOnlyOptions = {
    ...(options.replayStore !== undefined ? { replayStore: options.replayStore } : {}),
  };
}

/**
 * Locates the generated `.weldall-search/` directory by walking up from the
 * working directory. This is an operational concern the runtime resolves on
 * its own; the consuming site does not need to configure it.
 *
 * @param cwd - Starting directory for the upward walk.
 * @returns The directory containing `index.json`, or `undefined`.
 */
function findIndexDir(cwd: string): string | undefined {
  let current = cwd;
  // Walk up to the filesystem root looking for the generated index directory.
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(current, ".weldall-search", INDEX_FILE))) {
      return path.join(current, ".weldall-search");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * Whether the given URL points at a loopback host (`localhost`, `127.0.0.1`, `::1`).
 */
function isLoopbackOrigin(value: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolves the runtime configuration from the persisted
 * `.weldall-search/config.json` (written at build time from the integration
 * props). This module does **not** read a fixed `WELDALL_*` environment
 * contract — the consuming site passes deployable values in `astro.config.mjs`.
 * Runtime-only values stay in the server process.
 *
 * @returns The resolved config, the index directory, and any user-provided
 *   skill items to merge into the catalog.
 */
export function loadRuntimeConfig(): {
  config: RuntimeConfig;
  indexDir: string | undefined;
  skillsItems: PersistedConfig["skillsItems"];
} {
  const indexDir = findIndexDir(process.cwd());
  let persisted: PersistedConfig = {};
  if (indexDir) {
    const configPath = path.join(indexDir, CONFIG_FILE);
    if (existsSync(configPath)) {
      persisted = JSON.parse(readFileSync(configPath, "utf8")) as PersistedConfig;
    }
  }
  const issuer = persisted.issuer;
  const resource = persisted.resource;
  const publicOrigin = persisted.publicOrigin;
  const clientId = persisted.clientId;
  const searchPath = normalizeSearchPath(persisted.searchPath ?? DEFAULTS.searchPath);
  const language = persisted.language ?? DEFAULTS.language;
  const defaultLimitRaw = persisted.defaultLimit ?? DEFAULTS.defaultLimit;
  const defaultLimit =
    Number.isFinite(defaultLimitRaw) && defaultLimitRaw >= 1 ? Math.floor(defaultLimitRaw) : 10;
  const discoveryTimeoutMs = persisted.discoveryTimeoutMs;
  const discoveryProxyOrigin = persisted.discoveryProxyOrigin;
  const requiredScopes = persisted.requiredScopes as readonly string[] | undefined;

  if (
    !issuer ||
    !resource ||
    !publicOrigin ||
    !clientId ||
    !requiredScopes ||
    requiredScopes.length === 0
  ) {
    const missing: string[] = [];
    if (!issuer) missing.push("issuer");
    if (!resource) missing.push("resource");
    if (!publicOrigin) missing.push("publicOrigin");
    if (!clientId) missing.push("clientId");
    if (!requiredScopes || requiredScopes.length === 0) missing.push("requiredScopes");
    throw new Error(
      `@weldall/sdk/starlight: missing Weldall configuration: ${missing.join(", ")}. ` +
        "Provide them as integration options in astro.config.mjs.",
    );
  }

  const explicitLoopback = persisted.allowInsecureLoopback ?? false;

  const config: RuntimeConfig = {
    issuer,
    resource,
    publicOrigin,
    clientId,
    requiredScopes,
    searchPath,
    language,
    defaultLimit,
    allowInsecureLoopback: explicitLoopback || isLoopbackOrigin(publicOrigin),
  };
  if (discoveryTimeoutMs !== undefined) config.discoveryTimeoutMs = discoveryTimeoutMs;
  if (discoveryProxyOrigin !== undefined) config.discoveryProxyOrigin = discoveryProxyOrigin;

  return {
    config,
    indexDir,
    skillsItems: persisted.skillsItems,
  };
}

/**
 * Resolves the resource signing key from the server environment.
 *
 * @returns An ES256 signing key.
 */
async function resolveSigningKey(): Promise<DirectSigningKey> {
  const encoded = process.env.WELDALL_SIGNING_KEY;
  if (!encoded) {
    throw new Error("@weldall/sdk/starlight: WELDALL_SIGNING_KEY is required at runtime");
  }
  const parsed = JSON.parse(encoded) as DirectSigningKey;
  if (!parsed.kid || !parsed.privateJwk || !parsed.publicJwk) {
    throw new Error("WELDALL_SIGNING_KEY must be JSON with kid, privateJwk, and publicJwk");
  }
  return parsed;
}

/**
 * Derives a short site label from the public origin's hostname, used in the
 * auto-discovered skill title. Returns an empty string for loopback hosts.
 */
function siteLabelFor(publicOrigin: string): string {
  try {
    const hostname = new URL(publicOrigin).hostname;
    if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return "";
    return hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * The lazily-created runtime: the Weldall resource instance plus search.
 */
export interface SearchRuntime {
  /** The resolved runtime configuration. */
  config: RuntimeConfig;
  /** The Weldall resource instance (verify + metadata + skills handlers). */
  weldall: AstroWeldall;
  /** Runs a full-text search over the loaded index. */
  search(term: string, limit: number): Promise<SearchHit[]>;
}

let runtimePromise: Promise<SearchRuntime> | undefined;

/**
 * Returns the shared runtime singleton, creating it on first use. Creation is
 * lazy so an unauthenticated request never pays for key/discovery setup.
 */
export function getRuntime(): Promise<SearchRuntime> {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

/**
 * Creates the runtime: resolves config and signing key, builds the
 * auto-discovered search skill (merged with user skills), initializes the
 * Weldall resource via the Astro adapter, and loads the search index.
 */
async function createRuntime(): Promise<SearchRuntime> {
  const { config, indexDir, skillsItems } = loadRuntimeConfig();
  const signingKey = await resolveSigningKey();
  const replayStore = runtimeOnlyOptions.replayStore ?? inMemory();
  const generated = buildSearchSkill({
    publicOrigin: config.publicOrigin,
    resource: config.resource,
    searchPath: config.searchPath,
    requiredScopes: config.requiredScopes,
    siteLabel: siteLabelFor(config.publicOrigin),
  });
  const weldall = initWeldall(config.issuer, {
    resource: config.resource,
    publicOrigin: config.publicOrigin,
    clientId: config.clientId,
    supportedScopes: config.requiredScopes,
    signingKey,
    replayStore,
    allowInsecureLoopback: config.allowInsecureLoopback,
    ...(config.discoveryTimeoutMs !== undefined
      ? { discoveryTimeoutMs: config.discoveryTimeoutMs }
      : {}),
    ...(config.discoveryProxyOrigin !== undefined
      ? { discoveryProxyOrigin: config.discoveryProxyOrigin }
      : {}),
    skills: {
      items: [
        {
          id: generated.id,
          title: generated.title,
          requiredScopes: [...config.requiredScopes],
          visibility: "DEFAULT",
          content: generated.content,
          meta: { tags: ["search"] },
        },
        ...(skillsItems ?? []),
      ],
    },
  });

  const db = indexDir
    ? await readIndexFile(path.join(indexDir, INDEX_FILE)).catch(async (error: unknown) => {
        console.error(`[@weldall/sdk/starlight] failed to load search index: ${String(error)}`);
        return undefined;
      })
    : undefined;

  return {
    config,
    weldall,
    search: async (term, limit) => {
      if (!db) throw new Error("search index is not available (build the site to generate it)");
      return runSearch(db, term, limit);
    },
  };
}

export function resetRuntimeForTests(): void {
  runtimePromise = undefined;
  runtimeOnlyOptions = {};
}
