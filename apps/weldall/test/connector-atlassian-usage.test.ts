import { describe, expect, it } from "vitest";
import { atlassianProvider } from "../src/server/connectors/providers/atlassian";
import { parseGrant } from "../src/server/connectors/providers/atlassian/grant";

const cloudId = "0dd7e633-4416-4561-bf5a-dd50284528fe";
function display(products: ("jira" | "confluence")[], productScopes: string[]) {
  const scopes = ["offline_access", "read:me", ...productScopes].sort();
  const grant = parseGrant({
    cloudId,
    siteName: "Company",
    siteUrl: "https://company.atlassian.net",
    products,
    scopes,
  });
  const selection = { scopes };
  return {
    selection,
    grant,
    config: {
      clientId: "client",
      grantType: "resource",
      products,
      allowedCloudIds: [cloudId],
      allowedScopes: productScopes,
      defaultScopes: [],
    },
    metadata: atlassianProvider.describeConnection({ selection, grant }),
  };
}

describe("provider-generated Atlassian usage", () => {
  it("exposes bound Jira gateway examples and search pagination without leaking credentials", () => {
    const { metadata } = display(["jira"], ["read:jira-work"]);
    expect(metadata.usage.examples).toHaveLength(1);
    const example = metadata.usage.examples[0]!;
    const url = new URL(example.url);
    expect(url.origin).toBe("https://api.atlassian.com");
    expect(url.pathname).toBe(`/ex/jira/${cloudId}/rest/api/3/search/jql`);
    expect(url.searchParams.get("jql")).toBe("ORDER BY created DESC");
    expect(url.searchParams.get("fields")).toBe("summary,status,assignee,created");
    expect(example.method).toBe("GET");
    expect(metadata.usage.instructions.join(" ")).toContain("nextPageToken");
    expect(metadata.usage.instructions.join(" ")).toContain("unchanged");
    expect(metadata.usage.instructions.join(" ")).not.toContain("Confluence");
  });
  it.each([
    [["jira"], ["read:jira-user"], ["Current Jira user"]],
    [["jira"], ["read:user:jira"], ["Current Jira user"]],
    [["jira"], ["write:jira-work"], []],
    [["confluence"], ["read:confluence-content.all"], ["Confluence pages (v1)"]],
    [["confluence"], ["read:page:confluence"], ["Confluence pages"]],
    [["confluence"], ["read:confluence-space.summary"], ["Confluence spaces (v1)"]],
    [["confluence"], ["read:space:confluence"], ["Confluence spaces"]],
    [["confluence"], ["search:confluence"], ["Search Confluence pages"]],
    [["confluence"], ["write:confluence-content"], []],
  ] as const)(
    "limits examples to granted products %j and permissions %j",
    (products, scopes, labels) => {
      const { metadata } = display([...products], [...scopes]);
      expect(metadata.usage.examples.map((example) => example.label)).toEqual(labels);
    },
  );
  it("advertises Jira search when its complete granular scope set is granted", () => {
    const { metadata } = display(
      ["jira"],
      [
        "read:issue-details:jira",
        "read:audit-log:jira",
        "read:avatar:jira",
        "read:field-configuration:jira",
        "read:issue-meta:jira",
      ],
    );
    expect(metadata.usage.examples.map((example) => example.label)).toEqual(["Latest Jira issues"]);
  });
  it("generates only URLs accepted by the existing provider request boundary", () => {
    const { metadata, selection, grant, config } = display(
      ["jira", "confluence"],
      ["read:jira-work", "read:jira-user", "read:confluence-content.all", "search:confluence"],
    );
    expect(metadata.usage.examples).toHaveLength(4);
    for (const example of metadata.usage.examples) {
      const requestedUrl = new URL(example.url);
      expect(
        atlassianProvider.resolveUpstreamUrl({ config, selection, grant, requestedUrl }).toString(),
      ).toBe(example.url);
    }
    expect(metadata.usage.instructions.join(" ")).toContain("_links.next");
  });
});
