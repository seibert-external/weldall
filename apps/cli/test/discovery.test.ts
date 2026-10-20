import { beforeEach, expect, it, vi } from "vitest";
import { DISCOVERY_LIMITS } from "@weldall/sdk/mcp";
import { discoverNativeResources } from "../src/services/discovery.js";
import { loadNativeMcpCatalog, resolveNativeMcp } from "../src/services/native-mcp.js";
import type { WeldallConfig } from "../src/config.js";
import { listConnectors, listConnections } from "../src/services/connections.js";
import { listSkillsWithSubject, showSkillWithSubject } from "../src/services/skills.js";
import { requestMcp } from "../src/services/mcp.js";
import { listScopesWithSubject } from "../src/services/resources.js";

vi.mock("../src/services/resources.js", () => ({
  listScopesWithSubject: vi.fn(),
}));
vi.mock("../src/services/native-mcp.js", () => ({
  resolveNativeMcp: vi.fn(),
  loadNativeMcpCatalog: vi.fn(),
}));
vi.mock("../src/services/connections.js", () => ({
  listConnectors: vi.fn(),
  listConnections: vi.fn(),
}));
vi.mock("../src/services/skills.js", () => ({
  listSkillsWithSubject: vi.fn(),
  showSkillWithSubject: vi.fn(),
}));
vi.mock("../src/services/mcp.js", () => ({ requestMcp: vi.fn() }));
const config = { issuer: "https://weldall.example" } as WeldallConfig;
const connector = (key = "work") => ({
  key,
  name: `Atlassian ${key}`,
  type: "atlassian-mcp",
  capabilities: ["mcp" as const],
  scopes: [],
  requiredScopes: ["use"],
  defaultScopes: [],
});
const account = (id = "alice-work", connectorKey = "work") =>
  ({
    id,
    connectorKey,
    name: id,
    accountName: `Account ${id}`,
    capabilities: ["mcp" as const],
    connectorEnabled: true,
    status: "READY",
  }) as Awaited<ReturnType<typeof listConnections>>[number];
const skill = (slug: string, mcpDependencies: unknown[] = []) =>
  ({
    slug,
    title: slug,
    preview: "Jira workflow",
    source: { type: "admin" as const },
    requiredScopes: [],
    missingScopes: [],
    available: true,
    visibility: "DEFAULT" as const,
    updatedAt: "2026-01-01",
    document: `# ${slug}`,
    content: `# ${slug}`,
    mcpDependencies,
  }) as Awaited<ReturnType<typeof showSkillWithSubject>>["result"];
const catalog = (count: number, description = "") => ({
  tools: Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    inputSchema: { type: "object" as const },
    description,
    _meta: { "weldall/scopes": ["read"] },
  })),
  resources: [],
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listScopesWithSubject).mockResolvedValue({
    subject: "alice",
    result: { resources: [], assignedScopes: [] },
  });
  vi.mocked(listConnectors).mockResolvedValue([connector()]);
  vi.mocked(listConnections).mockResolvedValue([account()]);
  vi.mocked(listSkillsWithSubject).mockResolvedValue({
    subject: "alice",
    result: { items: [], warnings: [] },
  });
  vi.mocked(requestMcp).mockImplementation(async (_, operation) =>
    operation === "tools"
      ? { tools: catalog(2).tools }
      : { resources: [{ name: "Current", uri: "fixture://current" }] },
  );
  vi.mocked(resolveNativeMcp).mockImplementation(async (_, key) => ({
    subject: "alice",
    resource: {
      key,
      name: key,
      resourceIdentifier: `https://${key}.example/api`,
      authorizationServer: `https://${key}.example`,
      downstreamClientId: "cli",
      supportedScopes: ["read"],
      grantedScopes: ["read"],
      requestPrefixes: [`https://${key}.example/api`],
    },
    metadata: {
      schemaVersion: 1,
      transport: "streamable-http-stateless",
      endpoint: `https://${key}.example/api/mcp`,
      description: "Example",
      discoveryScopes: ["read"],
      capabilities: ["tools", "resources"],
      revision: "a".repeat(64),
    },
  }));
});
it("admits complete sources deterministically, never a truncated tool subset", async () => {
  vi.mocked(loadNativeMcpCatalog).mockImplementation(async () => catalog(100));
  const result = await discoverNativeResources(config, { resources: ["c", "a", "b"] });
  expect(result.results.map((entry) => [entry.key, entry.status])).toEqual([
    ["a", "resolved"],
    ["b", "resolved"],
    ["c", "unavailable"],
  ]);
  expect(result.results[2]).toMatchObject({ code: "capacity" });
  expect(result.results[0]).toHaveProperty("tools.length", 100);
  expect(result.results[1]).toHaveProperty("tools.length", 100);
});
it("reserves space for failure outcomes and preserves successes beside oversized definitions", async () => {
  vi.mocked(loadNativeMcpCatalog).mockImplementation(async (_, source) =>
    catalog(source.resource.key === "c" ? 1 : 65, "x".repeat(12_000)),
  );
  const result = await discoverNativeResources(config, { resources: ["a", "b", "c"] });
  expect(result.results.map((entry) => entry.status)).toEqual([
    "resolved",
    "unavailable",
    "resolved",
  ]);
  expect(result.results[1]).toMatchObject({ code: "capacity" });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(DISCOVERY_LIMITS.bytes);
});
it("does not publish definitions resolved under a different principal", async () => {
  const resolve = vi.mocked(resolveNativeMcp).getMockImplementation()!;
  vi.mocked(resolveNativeMcp).mockImplementation(async (...args) => ({
    ...(await resolve(...args)),
    subject: "bob",
  }));
  const result = await discoverNativeResources(config, { resources: ["a"] });
  expect(result.results[0]).toMatchObject({ status: "unavailable" });
  expect(loadNativeMcpCatalog).not.toHaveBeenCalled();
});
it("resolves a connector type once, preserving exact-tool selection and deduplicating overlaps", async () => {
  const result = await discoverNativeResources(config, {
    dependencies: [{ connectorKey: "work", tools: ["tool_0"], includeResources: false }],
  });
  expect(result.results).toMatchObject([
    {
      id: "connector:work",
      status: "resolved",
      whole: false,
      route: { connectionId: "alice-work" },
      tools: [{ name: "tool_0" }],
      resources: [],
    },
  ]);
  expect(requestMcp).toHaveBeenCalledTimes(1);
  vi.mocked(requestMcp).mockClear();
  const both = await discoverNativeResources(config, {
    connectorTypes: ["atlassian-mcp"],
    dependencies: [{ connectorKey: "work", tools: ["tool_0"], includeResources: false }],
  });
  expect(both.results).toHaveLength(1);
  expect(both.results[0]).toMatchObject({
    whole: true,
    selectors: ["connector-type:atlassian-mcp", "connector:work"],
    tools: [{ name: "tool_0" }, { name: "tool_1" }],
  });
  expect(requestMcp).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "preserves whole-source success when an overlapping exact skill fails (bound=%s)",
  async (bound) => {
    const documents = [
      skill("whole", [{ kind: "connector", connectorType: "atlassian-mcp" }]),
      skill("broken", [{ connectorKey: "work", tools: ["removed_tool"], includeResources: false }]),
    ];
    vi.mocked(listSkillsWithSubject).mockResolvedValue({
      subject: "alice",
      result: { items: documents, warnings: [] },
    });
    vi.mocked(showSkillWithSubject).mockImplementation(async (_, slug) => ({
      subject: "alice",
      result: documents.find((document) => document.slug === slug)!,
    }));
    const result = await discoverNativeResources(config, {
      connectorTypes: ["atlassian-mcp"],
      skills: ["whole", "broken"],
      bindings: bound
        ? [
            {
              selector: "connector-type:atlassian-mcp",
              connectorKey: "work",
              connectionId: "alice-work",
              whole: true,
              tools: ["tool_0", "removed_tool"],
            },
          ]
        : [],
    });
    expect(result.results).toMatchObject([
      {
        id: "connector:work",
        status: "resolved",
        direct: true,
        selectors: ["connector-type:atlassian-mcp"],
        tools: [{ name: "tool_0" }, { name: "tool_1" }],
      },
      { id: "skill:whole", status: "resolved", dependencies: ["connector:work"] },
      { id: "skill:broken", status: "incomplete", dependencies: ["connector:work"] },
    ]);
  },
);

it("does not choose among multiple connectors/accounts and accepts only an explicit offered ID", async () => {
  vi.mocked(listConnectors).mockResolvedValue([connector(), connector("second")]);
  vi.mocked(listConnections).mockResolvedValue([account(), account("other", "second")]);
  const result = await discoverNativeResources(config, { connectorTypes: ["atlassian-mcp"] });
  expect(result.results[0]).toMatchObject({
    status: "selection_required",
    catalogComplete: true,
    choices: [{ connectorName: "Atlassian work" }, { connectorName: "Atlassian second" }],
  });
  expect(requestMcp).not.toHaveBeenCalled();
  const continued = await discoverNativeResources(config, {
    connectorTypes: ["atlassian-mcp"],
    selection: { connectorKey: "second", connection: "other" },
  });
  expect(continued.results[0]).toMatchObject({
    status: "resolved",
    route: { connectorKey: "second", connectionId: "other" },
  });
});

it("never substitutes another account for an unavailable binding or invalid explicit choice", async () => {
  const bindings = [
    { selector: "connector-type:atlassian-mcp", connectorKey: "work", connectionId: "removed" },
  ];
  const result = await discoverNativeResources(config, {
    connectorTypes: ["atlassian-mcp"],
    bindings,
  });
  expect(result.results[0]).toMatchObject({
    status: "unavailable",
    code: "bound_connection_unavailable",
  });
  const selected = await discoverNativeResources(config, {
    connectorTypes: ["atlassian-mcp"],
    selection: { connectorKey: "work", connection: "invalid" },
  });
  expect(selected.results[0]).toMatchObject({ status: "unavailable" });
  expect(requestMcp).not.toHaveBeenCalled();
});

it("incomplete account catalogs cannot prove uniqueness", async () => {
  vi.mocked(listConnections).mockResolvedValue([
    account(),
    ...Array.from({ length: 199 }, (_, index) => account(`irrelevant-${index}`, "unrelated")),
  ]);
  const result = await discoverNativeResources(config, { connectorTypes: ["atlassian-mcp"] });
  expect(result.results[0]).toMatchObject({ status: "selection_required", catalogComplete: false });
  expect(requestMcp).not.toHaveBeenCalled();
});

it("expands skills through the same resolver and reports incomplete dependencies without losing successes", async () => {
  const document = skill("review", [
    { kind: "resource", resourceKey: "missing" },
    { kind: "connector", connectorType: "atlassian-mcp" },
  ]);
  vi.mocked(listSkillsWithSubject).mockResolvedValue({
    subject: "alice",
    result: { items: [document], warnings: [] },
  });
  vi.mocked(showSkillWithSubject).mockResolvedValue({ subject: "alice", result: document });
  vi.mocked(resolveNativeMcp).mockRejectedValue(new Error("denied secret"));
  const result = await discoverNativeResources(config, { skills: ["review"] });
  expect(result.results).toMatchObject([
    { id: "connector:work", status: "resolved", direct: false, viaSkills: ["review"] },
    { id: "resource:missing", status: "unavailable" },
    { kind: "skill", status: "incomplete", dependencies: ["resource:missing", "connector:work"] },
  ]);
  expect(JSON.stringify(result)).not.toContain("secret");
});

it("catalog-only search never reads skill documents, accounts, schemas or native tokens", async () => {
  vi.mocked(listSkillsWithSubject).mockResolvedValue({
    subject: "alice",
    result: { items: [skill("jira.review")], warnings: [] },
  });
  const result = await discoverNativeResources(config, { query: "Jira", catalogOnly: true });
  expect(result.results).toMatchObject([{ kind: "skill", key: "jira.review", status: "catalog" }]);
  expect(showSkillWithSubject).not.toHaveBeenCalled();
  expect(requestMcp).not.toHaveBeenCalled();
  expect(listConnections).not.toHaveBeenCalled();
});

it("searches authorized native descriptions and excludes HTTP-only or partially granted sources", async () => {
  const native = await resolveNativeMcp(config, "billing");
  vi.mocked(listScopesWithSubject).mockResolvedValue({
    subject: "alice",
    result: {
      assignedScopes: ["read"],
      resources: [
        { ...native.resource, mcp: { ...native.metadata, description: "Invoices" } },
        { ...native.resource, key: "invoices-http" },
        {
          ...native.resource,
          key: "invoices-denied",
          mcp: { ...native.metadata, discoveryScopes: ["read", "admin"] },
        },
      ],
    },
  });
  vi.mocked(resolveNativeMcp).mockClear();
  const result = await discoverNativeResources(config, { query: "invoices", catalogOnly: true });
  expect(result.results).toMatchObject([
    { key: "billing", description: "Invoices", status: "catalog" },
  ]);
  expect(resolveNativeMcp).not.toHaveBeenCalled();
  expect(loadNativeMcpCatalog).not.toHaveBeenCalled();
  expect(listScopesWithSubject).toHaveBeenCalledWith(config, expect.any(AbortSignal), true);
});

it("paginates search hits without activating unseen skills and binds cursors to the search snapshot", async () => {
  const items = Array.from({ length: 10 }, (_, index) => skill(`jira.${index}`));
  vi.mocked(listSkillsWithSubject).mockResolvedValue({
    subject: "alice",
    result: { items, warnings: [] },
  });
  vi.mocked(showSkillWithSubject).mockImplementation(async (_, slug) => ({
    subject: "alice",
    result: items.find((item) => item.slug === slug)!,
  }));
  const first = await discoverNativeResources(config, { query: "Jira" });
  expect(first.results).toHaveLength(8);
  expect(showSkillWithSubject).toHaveBeenCalledTimes(8);
  const second = await discoverNativeResources(config, { query: "Jira", cursor: first.nextCursor });
  expect(second.results).toHaveLength(2);
  expect(second.nextCursor).toBeUndefined();
  vi.mocked(listSkillsWithSubject).mockResolvedValue({
    subject: "alice",
    result: { items: items.slice(1), warnings: [] },
  });
  await expect(
    discoverNativeResources(config, { query: "Jira", cursor: first.nextCursor }),
  ).rejects.toThrow("catalog changed");
});

it("preserves existing exposure and reuses its exact account when a skill overlaps", async () => {
  vi.mocked(listConnections).mockResolvedValue([account(), account("second")]);
  const result = await discoverNativeResources(config, {
    dependencies: [{ connectorKey: "work", tools: ["tool_1"], includeResources: false }],
    bindings: [
      {
        selector: "connector:work",
        connectorKey: "work",
        connectionId: "alice-work",
        tools: ["tool_0"],
      },
    ],
  });
  expect(result.results[0]).toMatchObject({
    status: "resolved",
    route: { connectionId: "alice-work" },
    tools: [{ name: "tool_0" }, { name: "tool_1" }],
  });
});

it("rejects source overflow before discovery or token exchange", async () => {
  await expect(
    discoverNativeResources(config, {
      resources: Array.from({ length: 9 }, (_, index) => `source-${index}`),
    }),
  ).rejects.toThrow();
  expect(resolveNativeMcp).not.toHaveBeenCalled();
});
