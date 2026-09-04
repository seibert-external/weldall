import type { ReplayStore } from "../types.js";
import type { PublishedSkill } from "../skills.js";
import type { SearchLanguage } from "./languages.js";

/**
 * Customization of the auto-generated `search` skill published by the
 * integration. Any provided value overrides the corresponding generated part;
 * fields left empty keep the generated default.
 */
export interface SearchSkillOverride {
  /**
   * Custom skill title. Defaults to an origin-derived title, e.g.
   * `Search the docs knowledge base`.
   */
  title?: string;
  /**
   * Custom opening description used to steer skill discovery. Put concrete
   * user vocabulary and example tasks here; Weldall includes this opening in
   * the catalog preview searched by `weldall skills find`.
   */
  description?: string;
  /**
   * Full custom skill body. When provided it replaces the entire generated
   * content, including the search and page-read command blocks.
   */
  content?: string;
  /**
   * Extra operating rules appended after the generated rules. Use this to add
   * site-specific guidance (e.g. "pages under /office describe teams") while
   * keeping the generated commands.
   */
  extraRules?: string;
}

/**
 * Integration options for `weldallSearch(host, options)`.
 *
 * The Weldall identity fields mirror `initWeldall(host, options)` from this
 * SDK where the values are deployable build/runtime config. The signing key is
 * read from `process.env.WELDALL_SIGNING_KEY` in the server process. Configure
 * replay protection in server startup with `configureWeldallSearchRuntime`.
 */
export interface WeldallSearchOptions {
  // --- Weldall resource identity (mirrors WeldallOptions) ---

  /**
   * The resource URL registered in Weldall. The access-token `aud`/`resource`
   * claims must match this value.
   */
  resource?: string;

  /**
   * The public origin of this site, e.g. `https://docs.example.com`.
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
   * Skill publishing: additional skills to publish next to the auto-generated
   * search skill, plus an optional override of that generated search skill.
   */
  skills?: {
    /** Additional skills to publish next to the auto-generated search skill. */
    items?: readonly PublishedSkill[];
    /** Customize the auto-generated `search` skill. */
    search?: SearchSkillOverride;
  };

  // --- site-specific ---

  /** Content directory relative to the project root. Defaults to `"src/content/docs"`. */
  contentDir?: string;

  /** Search endpoint path. Defaults to `"/api/search"`. */
  searchPath?: string;

  /**
   * Content endpoint path used to read full pages by path. Defaults to
   * `"/api/content"`.
   */
  contentPath?: string;

  /** Search language used for stemming and stop-word removal. Defaults to `"english"`. */
  language?: SearchLanguage;

  /** Maximum results per query. Defaults to 10. */
  defaultLimit?: number;
}

/** Server-runtime options for the injected Starlight search routes. */
export interface WeldallSearchRuntimeOptions {
  /** DPoP replay-protection store. Defaults to a process-local store. */
  replayStore?: ReplayStore | "disabled";
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

/** A full page returned by the `/api/content` endpoint. */
export interface PageContent {
  /** Page route on the site, e.g. `/team/overview/`. */
  path: string;
  /** Page title from the frontmatter. */
  title: string;
  /** Page description from the frontmatter (may be empty). */
  description: string;
  /** Full page body as markdown. */
  content: string;
}
