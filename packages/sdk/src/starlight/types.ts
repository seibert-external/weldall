import type { DirectSigningKey } from "../types.js";
import type { ReplayStore } from "../types.js";
import type { SkillProvider } from "../skills.js";

/**
 * Integration options for `weldallSearch(host, options)`.
 *
 * The Weldall identity fields mirror `initWeldall(host, options)` from this
 * SDK — same names, same shapes. Configuration is **prop-driven**: the
 * consuming site passes values in `astro.config.mjs` and may read them from
 * its own environment variables however it likes (e.g.
 * `signingKey: JSON.parse(process.env.MY_KEY)`). The library accepts values,
 * never environment-variable names; the only environment read it keeps as a
 * convenience default is `process.env.WELDALL_SIGNING_KEY` for the signing
 * key. Only the site-specific fields (`contentDir`, `searchPath`, `language`,
 * `defaultLimit`) are unique to this integration.
 *
 * `replayStore` is optional for local development: a process-local store is
 * used when omitted. Production deployments should use a shared replay store.
 */
export interface WeldallSearchOptions {
  // --- Weldall resource identity (mirrors WeldallOptions) ---

  /**
   * The resource URL registered in Weldall. The access-token `aud`/`resource`
   * claims must match this value.
   */
  resource?: string;

  /**
   * The public origin of this site, e.g. `https://basics.seibert.tools`.
   */
  publicOrigin?: string;

  /**
   * The OAuth client id this resource accepts in incoming ID-JAGs and access
   * tokens — the CLI client allowed to query this resource. Must match the
   * registration at the Weldall AS.
   */
  clientId?: string;

  /**
   * Scopes **required to search**. The search endpoint requires all of them
   * and the auto-discovered skill lists them as its `requiredScopes`. A
   * search-only resource supports exactly these scopes, so they are also
   * advertised as the resource's supported scopes.
   */
  requiredScopes?: readonly string[];

  /** Timeout in milliseconds for authorization-server discovery. */
  discoveryTimeoutMs?: number;

  /** Origin used to proxy authorization-server discovery requests. */
  discoveryProxyOrigin?: string;

  /**
   * Allow `http://` loopback origins for local development. Automatically
   * enabled when `publicOrigin` is a loopback host.
   */
  allowInsecureLoopback?: boolean;

  /**
   * ES256 signing key, passed as the actual value — e.g.
   * `signingKey: JSON.parse(process.env.MY_KEY)` — so the consuming site
   * decides how to source it (its own environment variables, a secret store,
   * a file, ...). The library accepts a value, not an environment-variable
   * name. When omitted, it falls back to `process.env.WELDALL_SIGNING_KEY` at
   * runtime and, if that is absent too, an ephemeral key (local development
   * only).
   */
  signingKey?: DirectSigningKey;

  /** DPoP replay-protection store. Defaults to a process-local store. */
  replayStore?: ReplayStore | "disabled";

  /** Additional skills to publish next to the auto-generated search skill. */
  skills?: SkillProvider;

  // --- site-specific ---

  /** Content directory relative to the project root. Defaults to `"src/content/docs"`. */
  contentDir?: string;

  /** Search endpoint path. Defaults to `"/api/search"`. */
  searchPath?: string;

  /** Orama index language (stemming/stopwords). Defaults to `"german"`. */
  language?: string;

  /** Maximum results per query. Defaults to 10. */
  defaultLimit?: number;
}

/**
 * A serialized ES256 signing key used by the resource for ID-JAG exchanges.
 * Expected shape of the `WELDALL_SIGNING_KEY` environment variable.
 */
export interface SigningJson {
  /** Key id referenced by the `kid` header of signed tokens. */
  kid: string;
  /** Private P-256 JWK. */
  privateJwk: import("jose").JWK;
  /** Public P-256 JWK, advertised in the resource JWKS. */
  publicJwk: import("jose").JWK;
}

/** A single search result returned by the `/api/search` endpoint. */
export interface SearchHit {
  /** Page route on the site, e.g. `/team/overview/`. */
  path: string;
  /** Page title from the frontmatter. */
  title: string;
  /** Page description from the frontmatter (may be empty). */
  description: string;
  /** Plain-text excerpt of the page body. */
  excerpt: string;
  /** Orama relevance score. */
  score: number;
}
