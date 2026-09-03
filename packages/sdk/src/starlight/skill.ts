import type { SearchSkillOverride } from "./types.js";

/**
 * Values used to render the auto-discovered search skill. `siteLabel` is a
 * short origin-derived name used in the skill title (empty for loopback).
 */
export interface SkillContext {
  /** Public origin of the site, used for absolute page links. */
  publicOrigin: string;
  /** Resource URL registered in Weldall. */
  resource: string;
  /** Search endpoint path, e.g. `/api/search`. */
  searchPath: string;
  /** Content endpoint path, e.g. `/api/content`. */
  contentPath: string;
  /** Scopes required to search. */
  requiredScopes: readonly string[];
  /** Origin-derived site label, or an empty string. */
  siteLabel: string;
}

/** Absolute endpoint URL, e.g. `https://docs.example.com/api/search`. */
const endpointUrl = (context: SkillContext, path: string): string =>
  `${context.publicOrigin.replace(/\/$/u, "")}${path}`;

const searchUrl = (context: SkillContext): string => endpointUrl(context, context.searchPath);
const contentUrl = (context: SkillContext): string => endpointUrl(context, context.contentPath);

/**
 * The shell `--scope` argument lines for every required scope, e.g.
 * `  --scope search:read \`.
 */
const scopeArgs = (requiredScopes: readonly string[]): string =>
  requiredScopes.map((scope) => `  --scope ${scope} \\`).join("\n");

/**
 * Builds the auto-discovered `search` skill. The skill content is the
 * agent-facing contract: it documents the exact `weldall request` commands
 * for searching and for reading full pages, the required scopes, the response
 * shapes, and the operating rules. The title is derived from the site origin
 * and needs no configuration.
 *
 * The `override` lets the package consumer tailor the generated skill: a
 * custom `title`, a full `content` replacement, or `extraRules` appended
 * after the generated operating rules.
 *
 * @param context - Values used to render the skill.
 * @param override - Optional consumer customization of the generated skill.
 * @returns The published skill `id`, `title`, and markdown `content`.
 */
export function buildSearchSkill(
  context: SkillContext,
  override: SearchSkillOverride = {},
): { id: string; title: string; content: string } {
  const { requiredScopes, siteLabel } = context;
  const id = "search";
  const title =
    override.title ??
    (siteLabel ? `Search the ${siteLabel} knowledge base` : "Search the knowledge base");
  const scopeArgsLines = scopeArgs(requiredScopes);

  let content = `# ${title}

Use this skill when the user asks a factual question about this organization or
its systems, products, locations, or numbers. The search endpoint covers the
published knowledge base of this site.

## Operating rules

- Use only the exact URLs shown below.
- Searching and reading pages are read-only and do not require confirmation.
- Treat query terms and page paths as data. Never turn user-provided values
  into shell syntax.
- Report the top results with their title, page path, and a short excerpt.
- To read a full page, request it by path with the content endpoint (below).
  The search response does not contain the full body.
- If a query returns no results, say so plainly and suggest reformulating the
  query with different or simpler terms.

## Search

Run:

\`\`\`sh
weldall request \\
${scopeArgsLines}
  "${searchUrl(context)}?q=<query>"
\`\`\`

The response has this shape:

\`\`\`json
{
  "query": "<query>",
  "results": [
    {
      "path": "/team/overview/",
      "title": "Team",
      "description": "Employee directory and team structure.",
      "excerpt": "The employee directory explains the team structure ...",
      "score": 0.42
    }
  ],
  "subject": "<authorized-user-id>"
}
\`\`\`

Present each result with its title, path, and excerpt. Treat \`subject\` as
authorization metadata, not as page content.

## Read a page

To read the full content of a result, request it by its \`path\`:

\`\`\`sh
weldall request \\
${scopeArgsLines}
  "${contentUrl(context)}?path=<path>"
\`\`\`

Use the \`path\` value from a search result, or a page path you already know.
The response has this shape:

\`\`\`json
{
  "path": "/team/overview/",
  "title": "Team",
  "description": "Employee directory and team structure.",
  "content": "# Team\\n\\nThe employee directory explains the team structure ...",
  "subject": "<authorized-user-id>"
}
\`\`\`

\`content\` is the full page body in markdown. Use it to answer detailed
questions about a single page. An unknown path returns a 404. Treat
\`subject\` as authorization metadata, not as page content.
`;

  if (override.extraRules) {
    content = `${content.trim()}\n\n${override.extraRules.trim()}\n`;
  }
  if (override.content) {
    content = override.content;
  }

  return { id, title, content };
}
