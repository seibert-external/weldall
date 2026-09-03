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
  /** Scopes required to search. */
  requiredScopes: readonly string[];
  /** Origin-derived site label, or an empty string. */
  siteLabel: string;
}

/** Absolute search URL, e.g. `https://basics.seibert.tools/api/search`. */
const searchUrl = (context: SkillContext): string =>
  `${context.publicOrigin.replace(/\/$/u, "")}${context.searchPath}`;

/**
 * Builds the auto-discovered `search` skill. The skill content is the
 * agent-facing contract: it documents the exact `weldall request` command, the
 * required scope, the response shape, and the operating rules. The title is
 * derived from the site origin and needs no configuration.
 *
 * @param context - Values used to render the skill.
 * @returns The published skill `id`, `title`, and markdown `content`.
 */
export function buildSearchSkill(context: SkillContext) {
  const url = searchUrl(context);
  const { requiredScopes, siteLabel } = context;
  const id = "search";
  const title = siteLabel ? `Search the ${siteLabel} knowledge base` : "Search the knowledge base";
  const scopeArgs = requiredScopes.map((scope) => `  --scope ${scope} \\`).join("\n");
  const content = `# ${title}

Use this skill when the user asks a factual question about this organization or
its systems, products, locations, or numbers. The search endpoint covers the
published knowledge base of this site.

## Operating rules

- Use only the exact search URL shown below.
- Searching is read-only and does not require confirmation.
- Treat query terms as data. Never turn user-provided values into shell syntax.
- Report the top results with their title, page path, and a short excerpt.
- To read a full page, fetch the page at \`${context.publicOrigin}<path>\` in a
  second step. The search response does not contain the full body.
- If a query returns no results, say so plainly and suggest reformulating the
  query with different or simpler terms.

## Search

Run:

\`\`\`sh
weldall request \\
${scopeArgs}  "${url}?q=<query>"
\`\`\`

The response has this shape:

\`\`\`json
{
  "query": "<query>",
  "results": [
    {
      "path": "/team/overview/",
      "title": "Team",
      "description": "Mitarbeiterverzeichnis und Teamstruktur.",
      "excerpt": "Wir beschreiben das Mitarbeiterverzeichnis und die Teamstruktur ...",
      "score": 0.42
    }
  ],
  "subject": "<authorized-user-id>"
}
\`\`\`

Present each result with its title, path, and excerpt. Treat \`subject\` as
authorization metadata, not as page content. When the user wants more detail on
a result, fetch the page at \`${context.publicOrigin}<path>\`.
`;

  return { id, title, content };
}
