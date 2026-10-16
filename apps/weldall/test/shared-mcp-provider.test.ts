import { describe, expect, it } from "vitest";
import { atlassianMcpProvider as provider } from "../src/server/connectors/providers/atlassian-mcp";
import { ATLASSIAN_MCP } from "../src/server/connectors/providers/atlassian-mcp/config";
const config = { allowedScopes: ["read:jira:agent-interface"], defaultScopes: [] };
const input = {
  kind: "service-account-api-key",
  apiKey: "private-key-sentinel",
  cloudIds: ["00000000-0000-4000-8000-000000000001"],
};
const selection = { kind: input.kind, cloudIds: input.cloudIds };
const parsed = {
  selection,
  credentials: provider.parseCredentials({ kind: input.kind, apiKey: input.apiKey }),
  grant: provider.parseGrant({ ...selection, resource: ATLASSIAN_MCP.resource }),
};
describe("Atlassian static credentials", () => {
  it("uses fixed Bearer without permission declarations or organization confirmation", async () => {
    expect(provider.needsRefresh(parsed.credentials)).toBe(false);
    expect(
      await provider.ensureGrantCurrent({ config, ...parsed, previousGrant: parsed.grant }),
    ).toEqual(parsed.grant);
    const request = provider.mcp!.buildAuthenticatedRequest({
      endpoint: new URL("https://mcp.atlassian.com/v2/mcp"),
      credentials: parsed.credentials,
      method: "POST",
      headers: new Headers(),
      body: '{"arguments":{}}',
      signal: AbortSignal.timeout(1000),
    });
    expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${input.apiKey}`);
    expect(request.redirect).toBe("error");
    expect(request.body).toBe('{"arguments":{}}');
    const display = provider.describeConnection(parsed);
    expect(display.selectedScopes).toEqual([]);
    expect(display.grantedScopes).toEqual([]);
    expect(JSON.stringify(display)).not.toContain(input.apiKey);
    expect(JSON.stringify(display)).toContain("not inspected by Weldall");
    expect(
      await provider.disconnectGrant({ config, secrets: {}, credentials: parsed.credentials }),
    ).toMatchObject({ status: "unsupported", remediationUrl: "https://admin.atlassian.com" });
  });
  it("rejects mixed credentials, endpoint substitution and secret reflections", () => {
    expect(() =>
      provider.parseCredentials({ kind: input.kind, apiKey: input.apiKey, accessToken: "mixed" }),
    ).toThrow();
    expect(() =>
      provider.mcp!.buildAuthenticatedRequest({
        endpoint: new URL("https://evil.example"),
        credentials: { kind: input.kind, apiKey: input.apiKey },
        method: "POST",
        headers: new Headers(),
        signal: AbortSignal.timeout(1000),
      }),
    ).toThrow();
    expect(() =>
      provider.mcp!.assertSafeResult(
        { content: [{ type: "text", text: input.apiKey }] },
        { kind: input.kind, apiKey: input.apiKey },
      ),
    ).toThrow();
  });
  it.each([
    { accountName: "Redundant label" },
    { configuredScopes: ["read:jira:agent-interface"] },
    { apiTokenAuthenticationEnabled: true },
    { unexpected: "field" },
  ])("rejects obsolete or unknown fields: %j", async (extra) => {
    expect(() =>
      provider.validateSetupInput({ config, value: { ...parsed.selection, ...extra } }),
    ).toThrow();
    expect(() => provider.parseGrant({ ...parsed.grant, ...extra })).toThrow();
    await expect(
      provider.ensureGrantCurrent({
        config,
        ...parsed,
        selection: { ...parsed.selection, ...extra },
        previousGrant: parsed.grant,
      }),
    ).rejects.toThrow();
  });
  it("checks stored grant consistency independently of personal OAuth permission settings", async () => {
    await expect(
      provider.ensureGrantCurrent({
        config,
        ...parsed,
        previousGrant: provider.parseGrant({ ...parsed.grant, cloudIds: [] }),
      }),
    ).rejects.toThrow();
    expect(
      provider.validateSetupInput({
        config: { ...config, allowedScopes: ["write:jira:agent-interface"] },
        value: parsed.selection,
      }),
    ).toEqual(parsed.selection);
    expect(provider.staticConnection!.parseRotateInput({ apiKey: "replacement" })).toEqual({
      kind: input.kind,
      apiKey: "replacement",
    });
  });
});
