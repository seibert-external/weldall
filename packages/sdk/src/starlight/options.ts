import type { PublishedSkill } from "../skills.js";
import type { WeldallSearchOptions } from "./types.js";

/** Defaults for the site-specific configuration surface. */
export const DEFAULTS = {
  /** Default Orama index language. */
  language: "german",
  /** Default Starlight content directory. */
  contentDir: "src/content/docs",
  /** Default search endpoint path. */
  searchPath: "/api/search",
  /** Default maximum results per query. */
  defaultLimit: 10,
} as const;

/**
 * Non-secret configuration written next to the search index at build time and
 * read back by the runtime. Secrets and runtime-only values (the signing key,
 * `replayStore`) are deliberately not persisted.
 */
export interface PersistedConfig {
  /** Weldall authorization-server origin (the `host` argument). */
  issuer?: string;
  /** Resource URL. */
  resource?: string;
  /** Public origin of the site. */
  publicOrigin?: string;
  /** Accepted OAuth client id. */
  clientId?: string;
  /** Scopes required to search; the resource supports exactly these. */
  requiredScopes?: readonly string[];
  /** Authorization-server discovery timeout in milliseconds. */
  discoveryTimeoutMs?: number;
  /** Origin used to proxy authorization-server discovery. */
  discoveryProxyOrigin?: string;
  /** Whether `http://` loopback origins are allowed. */
  allowInsecureLoopback?: boolean;
  /** User-provided skills (items) merged into the published catalog. */
  skillsItems?: readonly PublishedSkill[];
  /** Orama index language. */
  language?: string;
  /** Search endpoint path. */
  searchPath?: string;
  /** Default maximum results per query. */
  defaultLimit?: number;
}

/**
 * Projects the integration options (plus the SDK `host`) onto the persisted
 * configuration object. Only serializable, non-secret values are copied.
 *
 * @param options - Integration options to persist.
 * @param host - The Weldall authorization-server origin, persisted as `issuer`.
 * @returns The persisted configuration for `.weldall-search/config.json`.
 */
export function toPersistedConfig(options: WeldallSearchOptions, host?: string): PersistedConfig {
  const persisted: PersistedConfig = {};
  if (host) persisted.issuer = host;
  if (options.resource !== undefined) persisted.resource = options.resource;
  if (options.publicOrigin !== undefined) persisted.publicOrigin = options.publicOrigin;
  if (options.clientId !== undefined) persisted.clientId = options.clientId;
  if (options.requiredScopes !== undefined) {
    persisted.requiredScopes = [...options.requiredScopes];
  }
  if (options.discoveryTimeoutMs !== undefined) {
    persisted.discoveryTimeoutMs = options.discoveryTimeoutMs;
  }
  if (options.discoveryProxyOrigin !== undefined) {
    persisted.discoveryProxyOrigin = options.discoveryProxyOrigin;
  }
  if (options.allowInsecureLoopback !== undefined) {
    persisted.allowInsecureLoopback = options.allowInsecureLoopback;
  }
  if (options.skills && "items" in options.skills) {
    persisted.skillsItems = [...options.skills.items];
  }
  if (options.language !== undefined) persisted.language = options.language;
  if (options.searchPath !== undefined) persisted.searchPath = normalizeSearchPath(options.searchPath);
  if (options.defaultLimit !== undefined) persisted.defaultLimit = options.defaultLimit;
  return persisted;
}

/**
 * Normalizes a search endpoint path to a leading-slash form without a trailing
 * slash, e.g. `"api/search"` -> `"/api/search"`.
 *
 * @param value - Raw path from configuration or environment.
 * @returns The normalized path.
 */
export function normalizeSearchPath(value: string): string {
  const path = value.startsWith("/") ? value : `/${value}`;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
