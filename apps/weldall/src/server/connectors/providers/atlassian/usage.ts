import type { ConnectionUsage } from "../../display";
import { parseGrant } from "./grant";

/** Builds guidance exclusively from the connection's verified, single-site grant. */
export function describeAtlassianUsage(value: unknown): ConnectionUsage {
  const grant = parseGrant(value);
  const instructions = [
    "Send requests to the api.atlassian.com gateway, not the site's atlassian.net URL. Weldall forwards the gateway URL unchanged.",
  ];
  const examples: ConnectionUsage["examples"] = [];
  if (grant.products.includes("jira")) {
    const base = `https://api.atlassian.com/ex/jira/${grant.cloudId}`;
    instructions.push(`Jira API base: ${base}/rest/api/3/`);
    if (grant.scopes.includes("read:jira-work")) {
      const url = new URL(`${base}/rest/api/3/search/jql`);
      url.search = new URLSearchParams({
        jql: "ORDER BY created DESC",
        maxResults: "10",
        fields: "summary,status,assignee,created",
      }).toString();
      examples.push({ label: "Latest Jira issues", method: "GET", url: url.toString() });
      instructions.push(
        "To search a project, set jql to 'project = PROJECT_KEY ORDER BY created DESC' and URL-encode the query value. Use /rest/api/3/search/jql, not the old /rest/api/3/search endpoint.",
        "Jira issue search uses nextPageToken: request the next page with that query parameter, keeping the same JQL and fields. Stop when isLast is true or no nextPageToken is returned. Do not assume the response includes a total count.",
      );
    }
    if (grant.scopes.includes("read:jira-user"))
      examples.push({
        label: "Current Jira user",
        method: "GET",
        url: `${base}/rest/api/3/myself`,
      });
  }
  if (grant.products.includes("confluence")) {
    const base = `https://api.atlassian.com/ex/confluence/${grant.cloudId}`;
    instructions.push(
      `Confluence API base: ${base}/wiki/api/v2/ (v2) or ${base}/wiki/rest/api/ (v1).`,
    );
    if (grant.scopes.includes("read:confluence-content.all")) {
      examples.push({
        label: "Confluence pages",
        method: "GET",
        url: `${base}/wiki/api/v2/pages?limit=10`,
      });
      instructions.push(
        "For Confluence v2 pages, take the cursor from the JSON response's _links.next URL and request the same gateway endpoint with cursor set to that value. Stop when _links.next is absent.",
      );
    }
    if (grant.scopes.includes("search:confluence")) {
      examples.push({
        label: "Search Confluence pages",
        method: "GET",
        url: `${base}/wiki/rest/api/search?cql=type%3Dpage&limit=10`,
      });
      instructions.push(
        "For Confluence search, use the next-page query parameters from the JSON response's _links.next URL on the same gateway search endpoint. Stop when _links.next is absent.",
      );
    }
  }
  return { instructions, examples };
}
