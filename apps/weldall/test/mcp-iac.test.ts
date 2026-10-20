import { describe, expect, it } from "vitest";
import { parseDesiredState, importRequestSchema } from "../src/server/iac/contracts";
import { createPlan, desiredObjects, skillMcpState } from "../src/server/iac/planner";
const source = () => ({
  apiVersion: "weldall.dev/v1",
  workspace: {
    id: "67ade6dc-0000-4000-8000-000000000000",
    name: "mcp",
    issuer: "https://weldall.example.com",
  },
  connectors: {
    atlassian: {
      key: "atlassian-mcp",
      name: "Atlassian MCP",
      type: "atlassian-mcp",
      enabled: true,
      envelopeProvider: "LOCAL_ENV",
      requiredScopes: [],
      provider: {
        allowedScopes: ["read:jira:agent-interface"],
        defaultScopes: ["read:jira:agent-interface"],
      },
    },
  },
  skills: {
    review: {
      slug: "jira.review",
      title: "Review",
      content: "# Review",
      visibility: "DEFAULT",
      requiredScopes: [],
      mcpDependencies: [
        {
          connectorKey: "atlassian-mcp",
          tools: ["searchJiraIssuesUsingJql"],
          includeResources: false,
        },
      ],
    },
  },
});
describe("MCP connector and skill IaC graph", () => {
  it("round-trips whole-source forms and orders resources and connector families before their skills", () => {
    const input = source();
    const manifest = parseDesiredState({
      ...input,
      resources: {
        billing: {
          key: "billing",
          name: "Billing",
          resourceIdentifier: "https://billing.example/api",
          authorizationServer: "https://billing.example",
          downstreamClientId: "cli",
          enabled: true,
          requestPrefixes: ["https://billing.example/api"],
          scopes: [],
        },
      },
      skills: {
        review: {
          ...input.skills.review,
          mcpDependencies: [
            { kind: "resource", resourceKey: "billing" },
            { kind: "connector", connectorType: "atlassian-mcp" },
          ],
        },
      },
    });
    const plan = createPlan(manifest, { revision: 0, objects: [] });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.at(-1)?.kind).toBe("skill");
    const state = skillMcpState(manifest.skills.review!.mcpDependencies);
    expect(
      parseDesiredState({
        ...manifest,
        skills: { review: { ...manifest.skills.review!, ...state } },
      }),
    ).toEqual(manifest);
    const objects = desiredObjects(manifest).map((object, index) => ({
      ...object,
      id: String(index),
      version: 1,
      ownerWorkspaceId: manifest.workspace.id,
    }));
    const empty = parseDesiredState({
      apiVersion: manifest.apiVersion,
      workspace: manifest.workspace,
    });
    expect(createPlan(empty, { revision: 1, objects }).actions[0]?.kind).toBe("skill");
    manifest.resources.billing!.enabled = false;
    expect(createPlan(manifest, { revision: 1, objects }).blockers).toContainEqual(
      expect.objectContaining({ code: "UNRESOLVED_MCP_DEPENDENCY" }),
    );
  });
  it("retains a connector-type dependency when another eligible configured connector remains", () => {
    const input = source();
    const manifest = parseDesiredState({
      ...input,
      connectors: { ...input.connectors, second: { ...input.connectors.atlassian, key: "second" } },
      skills: {
        review: {
          ...input.skills.review,
          mcpDependencies: [{ kind: "connector", connectorType: "atlassian-mcp" }],
        },
      },
    });
    manifest.connectors.atlassian!.enabled = false;
    expect(createPlan(manifest, { revision: 0, objects: [] }).blockers).toEqual([]);
    manifest.connectors.second!.enabled = false;
    expect(createPlan(manifest, { revision: 0, objects: [] }).blockers).toContainEqual(
      expect.objectContaining({ code: "UNRESOLVED_MCP_DEPENDENCY" }),
    );
  });
  it("rejects account selectors, wildcard tools and malformed new dependencies", () => {
    for (const dependency of [
      { kind: "resource", resourceKey: "billing", connectionId: "secret-choice" },
      { kind: "connector", connectorType: "atlassian-mcp", tools: ["*"] },
      { kind: "resource" },
    ])
      expect(() => skillMcpState([dependency])).toThrow();
  });
  it("reserves weldall:mcp for machines and rejects secret shells", () => {
    expect(() =>
      parseDesiredState({
        ...source(),
        scopes: { mcp: { key: "weldall:mcp", description: "Reserved" } },
      }),
    ).toThrow();
    expect(() =>
      parseDesiredState({
        ...source(),
        emailAssignments: { user: { email: "user@example.com", scopes: ["weldall:mcp"] } },
      }),
    ).toThrow("machine-only");
    expect(parseDesiredState({ ...source(), sharedConnections: {} }).sharedConnections).toEqual({});
  });
  it("orders connector before skill creation without a separate primitive or client secret", () => {
    const plan = createPlan(parseDesiredState(source()), { revision: 0, objects: [] });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.map((a) => a.kind)).toEqual(["connector", "skill"]);
    expect(JSON.stringify(plan)).not.toContain("clientSecret");
  });
  it.each(["missing", "disabled"] as const)("blocks a %s connector dependency", (condition) => {
    const input = source();
    if (condition === "missing") input.connectors = {} as typeof input.connectors;
    else input.connectors.atlassian.enabled = false;
    expect(createPlan(parseDesiredState(input), { revision: 0, objects: [] }).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNRESOLVED_MCP_DEPENDENCY" })]),
    );
  });
  it("rejects a REST-only connector as an MCP dependency", () => {
    const manifest = parseDesiredState(source());
    const connector = manifest.connectors.atlassian!;
    manifest.connectors.atlassian = {
      ...connector,
      type: "google",
      provider: { clientId: "google-client", allowedScopes: [], defaultScopes: [] },
    };
    expect(createPlan(manifest, { revision: 0, objects: [] }).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNRESOLVED_MCP_DEPENDENCY" })]),
    );
  });
  it.each(["manual", "other-workspace"])(
    "does not block unrelated plans for a %s skill whose connector never supported MCP",
    (owner) => {
      const manifest = parseDesiredState(source());
      manifest.connectors.atlassian = {
        ...manifest.connectors.atlassian!,
        type: "google",
        provider: { clientId: "google-client", allowedScopes: [], defaultScopes: [] },
      };
      const objects = desiredObjects(manifest).map((object, index) => ({
        ...object,
        id: String(index),
        version: 1,
        ...(owner === "other-workspace" ? { ownerWorkspaceId: "other-workspace" } : {}),
      }));
      const unrelated = parseDesiredState({
        apiVersion: manifest.apiVersion,
        workspace: manifest.workspace,
        scopes: { read: { key: "unrelated:read", description: "Unrelated permission" } },
      });
      const plan = createPlan(unrelated, { revision: 1, objects });
      expect(plan.blockers).toEqual([]);
      expect(plan.actions).toMatchObject([{ action: "create", kind: "scope" }]);
    },
  );
  it("orders skill deletion before connector deletion and blocks retained dependants", () => {
    const manifest = parseDesiredState(source());
    const objects = desiredObjects(manifest).map((object, index) => ({
      ...object,
      id: String(index),
      version: 1,
      ownerWorkspaceId: manifest.workspace.id,
    }));
    const empty = parseDesiredState({
      apiVersion: manifest.apiVersion,
      workspace: manifest.workspace,
    });
    const plan = createPlan(empty, { revision: 1, objects });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.map((a) => a.kind)).toEqual(["skill", "connector"]);
    const retained = objects.map((o) =>
      o.kind === "skill" ? { ...o, ownerWorkspaceId: "another-workspace" } : o,
    );
    expect(createPlan(empty, { revision: 1, objects: retained }).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNRESOLVED_MCP_DEPENDENCY" })]),
    );
  });
  it("rejects the removed prototype configuration rather than translating it", () => {
    expect(() => parseDesiredState({ ...source(), mcpServers: {} })).toThrow();
    expect(
      importRequestSchema.safeParse({
        workspace: source().workspace,
        operationId: "67ade6dc-0000-4000-8000-000000000001",
        kind: "mcpServer",
        identity: "work",
        address: "mcpServer.work",
      }).success,
    ).toBe(false);
    expect(() =>
      skillMcpState([{ serverKey: "atlassian", tools: ["read"], includeResources: false }]),
    ).toThrow();
  });
  it("omits empty dependencies for shipped manifests and rejects malformed persistence", () => {
    expect(skillMcpState([])).toEqual({});
    expect(() => skillMcpState(null)).toThrow();
    expect(() =>
      skillMcpState([{ connectorKey: "atlassian-mcp", tools: "read", includeResources: false }]),
    ).toThrow();
  });
});
