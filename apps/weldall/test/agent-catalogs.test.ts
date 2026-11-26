import { randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import { parseAgentCatalogPage } from "../src/server/agents/discovery.js";
import {
  agentsOffered,
  listDiscoveredAgents,
  listVisibleAgents,
} from "../src/server/agents/service.js";
import { refreshResourceCatalog } from "../src/server/skills/catalogs.js";

const id = randomUUID().replaceAll("-", "");
const key = `agenttest-${id}`;
const origin = `https://${key}.example`;
const resourceIdentifier = `${origin}/api`;
const metadataUrl = `${origin}/.well-known/oauth-protected-resource/api`;
const skillsEndpoint = `${origin}/.well-known/weldall-skills`;
const agentsEndpoint = `${origin}/.well-known/weldall-agents`;
const by = "agent-catalog-test";

const intranetScope = `agenttest${id}:intranet`;
const salesScope = `agenttest${id}:sales`;
const owner = { id: `owner-${id}`, email: `${id}-owner@example.com` };
const colleague = { id: `colleague-${id}`, email: `${id}-colleague@example.com` };
const stranger = { id: `stranger-${id}`, email: `${id}-stranger@example.com` };
const admin = { id: `admin-${id}`, email: `${id}-admin@example.com` };

const definition = {
  instructions: "Read the intranet pages before you answer.",
  starters: ["What is new this week?"],
  tools: { mode: "all" },
};
const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "agt_intranet",
  name: "Intranet helper",
  description: "Answers questions about the intranet",
  owner: owner.id,
  scopes: [intranetScope, salesScope],
  config: { format: "weldall-agent", version: 1, definition },
  revision: 3,
  updatedAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
  ...overrides,
});

/** What the resource serves; tests replace it. `agentPages: null` drops the agent endpoint. */
const served: {
  agentPages: Array<Record<string, unknown>> | null;
  agentStatus: number;
  skillsEndpoint: boolean;
  agentApi?: unknown;
} = { agentPages: [], agentStatus: 200, skillsEndpoint: false };
/** Requests per URL without its query. */
const requested: string[] = [];
const assertions: string[] = [];

const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
  );
  requested.push(`${url.origin}${url.pathname}`);
  if (url.toString() === metadataUrl)
    return Response.json({
      resource: resourceIdentifier,
      authorization_servers: [origin],
      ...(served.skillsEndpoint ? { weldall_skills_endpoint: skillsEndpoint } : {}),
      ...(served.agentPages ? { weldall_agents_endpoint: agentsEndpoint } : {}),
      ...(served.agentApi === undefined ? {} : { weldall_agents_api: served.agentApi }),
    });
  if (url.toString() === skillsEndpoint)
    return Response.json({
      schemaVersion: 1,
      resource: resourceIdentifier,
      skills: [
        {
          id: "howto",
          title: "How to share an agent",
          requiredScopes: [],
          visibility: "DEFAULT",
          content: "# How to share an agent",
        },
      ],
    });
  if (`${url.origin}${url.pathname}` === agentsEndpoint) {
    assertions.push(new Headers(init?.headers).get("authorization")!.replace(/^Bearer /, ""));
    if (served.agentStatus !== 200) return new Response(null, { status: served.agentStatus });
    const cursor = url.searchParams.get("cursor");
    return Response.json(served.agentPages![cursor === null ? 0 : Number(cursor)]);
  }
  return new Response(null, { status: 404 });
}) as unknown as typeof fetch;

const page = (agents: unknown[], nextCursor?: string) => ({
  schemaVersion: 1,
  resource: resourceIdentifier,
  agents,
  ...(nextCursor === undefined ? {} : { nextCursor }),
});
const refresh = () => refreshResourceCatalog(resource.id, { fetcher });
const storedAgents = () =>
  db.discoveredAgent.findMany({
    where: { catalog: { resourceId: resource.id } },
    orderBy: { localId: "asc" },
  });

const priorSigningEnv = {
  kid: process.env.WELDALL_SIGNING_KID,
  privateJwk: process.env.WELDALL_SIGNING_PRIVATE_JWK,
  publicJwk: process.env.WELDALL_SIGNING_PUBLIC_JWK,
};
const signingKey = await generateEs256KeyPair();
process.env.WELDALL_SIGNING_KID = `agent-test-${id}`;
process.env.WELDALL_SIGNING_PRIVATE_JWK = JSON.stringify(signingKey.privateJwk);
process.env.WELDALL_SIGNING_PUBLIC_JWK = JSON.stringify(signingKey.publicJwk);

const resource = await db.downstreamResource.create({
  data: {
    key,
    name: "Agent catalog test",
    resourceIdentifier,
    authorizationServer: origin,
    downstreamClientId: `client-${key}`,
    enabled: true,
    // Agents only: the resource publishes no skill catalog.
    skillDiscoveryEnabled: false,
    agentDiscoveryEnabled: true,
    createdBy: by,
    updatedBy: by,
    discoveredCatalog: { create: {} },
  },
});
const scopeIds: Record<string, string> = {};
for (const scopeKey of [intranetScope, salesScope])
  scopeIds[scopeKey] = (
    await db.scope.create({
      data: { key: scopeKey, description: "Agent catalog test", createdBy: by, updatedBy: by },
    })
  ).id;
const adminScope = await db.scope.findUniqueOrThrow({ where: { key: "weldall:administer" } });
const grant = (email: string, scopes: string[]) =>
  db.emailScopeAssignment.create({
    data: {
      normalizedEmail: email,
      createdBy: by,
      updatedBy: by,
      grants: { create: scopes.map((scopeId) => ({ id: randomUUID(), scopeId, createdBy: by })) },
    },
  });
// The owner holds no scope at all (any more): owning the agent is enough to see it.
await grant(colleague.email, [scopeIds[salesScope]!]);
await grant(admin.email, [adminScope.id]);
await db.user.create({
  data: { id: owner.id, name: "Olivia Owner", email: owner.email, emailVerified: true },
});

afterAll(async () => {
  await db.emailScopeAssignment.deleteMany({
    where: { normalizedEmail: { in: [colleague.email, admin.email] } },
  });
  await db.downstreamResource.deleteMany({ where: { id: resource.id } });
  await db.scope.deleteMany({ where: { key: { in: [intranetScope, salesScope] } } });
  await db.user.deleteMany({ where: { id: owner.id } });
  for (const [name, value] of [
    ["WELDALL_SIGNING_KID", priorSigningEnv.kid],
    ["WELDALL_SIGNING_PRIVATE_JWK", priorSigningEnv.privateJwk],
    ["WELDALL_SIGNING_PUBLIC_JWK", priorSigningEnv.publicJwk],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(async () => {
  served.agentPages = [page([agent()])];
  served.agentStatus = 200;
  delete served.agentApi;
  served.skillsEndpoint = false;
  assertions.length = 0;
  requested.length = 0;
  await db.downstreamResource.update({
    where: { id: resource.id },
    data: { skillDiscoveryEnabled: false, agentDiscoveryEnabled: true },
  });
  await db.discoveredSkillCatalog.update({
    where: { resourceId: resource.id },
    data: { refreshLeaseId: null, refreshLeaseUntil: null },
  });
});

describe("agent discovery", () => {
  it("reads every page with its own signed assertion and stores the agents", async () => {
    served.agentPages = [
      page([agent()], "1"),
      page([agent({ id: "agt_private", name: "Only mine", scopes: [] })]),
    ];
    await expect(refresh()).resolves.toBe("succeeded");

    expect(await storedAgents()).toMatchObject([
      {
        localId: "agt_intranet",
        canonicalId: `${key}.agt_intranet`,
        name: "Intranet helper",
        ownerId: owner.id,
        scopes: [intranetScope, salesScope],
        configFormat: "weldall-agent",
        configVersion: 1,
        config: definition,
        revision: 3,
        sourceUpdatedAt: new Date("2026-11-20T10:00:00.000Z"),
        expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      },
      { localId: "agt_private", scopes: [] },
    ]);

    expect(assertions).toHaveLength(2);
    expect(new Set(assertions).size).toBe(2);
    for (const assertion of assertions) {
      expect(decodeProtectedHeader(assertion)).toMatchObject({
        alg: "ES256",
        typ: "weldall-agents+jwt",
      });
      const claims = decodeJwt(assertion);
      expect(claims).toMatchObject({
        iss: claims.sub,
        aud: agentsEndpoint,
        resource: resourceIdentifier,
        purpose: "agents:read",
      });
      expect(claims.exp! - claims.iat!).toBe(60);
    }
  });

  it("shows an agent to its owner and to holders of any one of its scopes", async () => {
    await expect(refresh()).resolves.toBe("succeeded");

    const own = await listVisibleAgents(owner);
    expect(own).toMatchObject({
      warnings: [],
      registries: [],
      items: [
        {
          id: `${key}.agt_intranet`,
          sourceId: "agt_intranet",
          name: "Intranet helper",
          description: "Answers questions about the intranet",
          own: true,
          ownerName: "Olivia Owner",
          scopes: [intranetScope, salesScope],
          config: { format: "weldall-agent", version: 1, definition },
          revision: 3,
          updatedAt: "2026-11-20T10:00:00.000Z",
          expiresAt: "2100-01-01T00:00:00.000Z",
          expired: false,
          source: { type: "resource", key, name: "Agent catalog test" },
        },
      ],
    });

    // The colleague holds only one of the two scopes.
    const shared = await listVisibleAgents(colleague);
    expect(shared.items).toMatchObject([
      { id: `${key}.agt_intranet`, own: false, ownerName: "Olivia Owner" },
    ]);
    expect((await listVisibleAgents(stranger)).items).toEqual([]);
    // Administering Weldall does not open other people's agents.
    expect((await listVisibleAgents(admin)).items).toEqual([]);
  });

  it("keeps an agent without scopes to its owner and flags an expired one", async () => {
    served.agentPages = [
      page([
        agent({ id: "agt_private", name: "Only mine", scopes: [] }),
        agent({ id: "agt_old", name: "Old", expiresAt: "2020-01-01T00:00:00.000Z" }),
      ]),
    ];
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleAgents(owner)).items).toMatchObject([
      { sourceId: "agt_old", expired: true },
      { sourceId: "agt_private", expired: false },
    ]);
    expect((await listVisibleAgents(colleague)).items).toMatchObject([
      { sourceId: "agt_old", expired: true },
    ]);
  });

  it("tells a client where agents are kept and which permissions it can share with", async () => {
    await db.resourceScope.create({
      data: { resourceId: resource.id, scopeId: scopeIds[salesScope]! },
    });
    const api = { endpoint: `${origin}/api/agents`, scope: salesScope };
    served.agentApi = api;
    await expect(refresh()).resolves.toBe("succeeded");

    // The colleague holds the resource's permission, the owner holds none.
    const allowed = await listVisibleAgents(colleague);
    expect(allowed.registries).toEqual([
      { key, name: "Agent catalog test", ...api, allowed: true },
    ]);
    expect(allowed.shareableScopes).toEqual([
      { key: salesScope, description: "Agent catalog test" },
    ]);
    const other = await listVisibleAgents(owner);
    expect(other.registries).toMatchObject([{ key, allowed: false }]);
    expect(other.shareableScopes).toEqual([]);
    // Weldall's own permissions are never offered for sharing.
    expect((await listVisibleAgents(admin)).shareableScopes).toEqual([]);

    // A permission that is not the resource's own is not passed on.
    served.agentApi = { ...api, scope: intranetScope };
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleAgents(colleague)).registries).toEqual([]);
    // An address elsewhere, or half an entry, fails the refresh like other broken metadata.
    served.agentApi = { ...api, endpoint: "https://elsewhere.example.com/api/agents" };
    await expect(refresh()).resolves.not.toBe("succeeded");
    served.agentApi = { endpoint: api.endpoint };
    await expect(refresh()).resolves.not.toBe("succeeded");
  });

  it("offers the Agents tab while a resource has agent discovery switched on", async () => {
    expect(await agentsOffered()).toBe(true);
    const others = await db.downstreamResource.count({
      where: { enabled: true, agentDiscoveryEnabled: true, id: { not: resource.id } },
    });
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { agentDiscoveryEnabled: false },
    });
    try {
      expect(await agentsOffered()).toBe(others > 0);
    } finally {
      await db.downstreamResource.update({
        where: { id: resource.id },
        data: { agentDiscoveryEnabled: true },
      });
    }
  });

  it("never opens an agent through one of Weldall's own permissions", async () => {
    served.agentPages = [page([agent({ scopes: ["weldall:administer", intranetScope] })])];
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleAgents(admin)).items).toEqual([]);
    expect((await listVisibleAgents(owner)).items).toHaveLength(1);
  });

  it("names no owner Weldall does not know", async () => {
    served.agentPages = [page([agent({ owner: `gone-${id}` })])];
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleAgents(colleague)).items).toMatchObject([
      { own: false, ownerName: null },
    ]);
  });

  it("replaces the copy on every refresh", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    served.agentPages = [page([agent({ id: "agt_other", name: "Other" })])];
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_other"]);
    // Skill discovery is off: the skill catalog is not even asked for.
    expect(requested).not.toContain(skillsEndpoint);
  });

  it("reads agents only from a resource the administrator switched it on for", async () => {
    served.skillsEndpoint = true;
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { skillDiscoveryEnabled: true, agentDiscoveryEnabled: false },
    });
    // The resource names the agent endpoint all the same.
    await expect(refresh()).resolves.toBe("succeeded");
    expect(requested).toContain(skillsEndpoint);
    expect(requested).not.toContain(agentsEndpoint);
    expect(await storedAgents()).toEqual([]);
    expect((await listVisibleAgents(owner)).items).toEqual([]);
    const skills = () =>
      db.discoveredSkill.count({ where: { catalog: { resourceId: resource.id } } });
    expect(await skills()).toBe(1);

    // Both on: skills and agents are replaced together.
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { agentDiscoveryEnabled: true },
    });
    await expect(refresh()).resolves.toBe("succeeded");
    expect(await storedAgents()).toHaveLength(1);
    expect(await skills()).toBe(1);

    // Skills off again: the next refresh removes them and keeps the agents.
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { skillDiscoveryEnabled: false },
    });
    await expect(refresh()).resolves.toBe("succeeded");
    expect(await skills()).toBe(0);
    expect(await storedAgents()).toHaveLength(1);
  });

  it("fails the refresh when agents are switched on and the resource names no endpoint", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    served.agentPages = null;
    await expect(refresh()).resolves.toBe("failed");
    const catalog = await db.discoveredSkillCatalog.findUniqueOrThrow({
      where: { resourceId: resource.id },
    });
    expect(catalog.lastFailureCategory).toBe("metadata_invalid");
    expect(await storedAgents()).toHaveLength(1);
  });

  it.each([
    ["an unreachable endpoint", { agentStatus: 503 }, "agents_unavailable"],
    ["a refused assertion", { agentStatus: 401 }, "agents_unauthorized"],
    ["another resource's page", { pages: [{ ...page([]), resource: origin }] }, "agents_invalid"],
    ["an unknown field", { pages: [page([agent({ command: "rm -rf" })])] }, "agents_invalid"],
    ["an invalid scope", { pages: [page([agent({ scopes: ["Everyone"] })])] }, "agents_invalid"],
    ["the same agent twice", { pages: [page([agent()], "1"), page([agent()])] }, "agents_invalid"],
    ["a cursor that repeats", { pages: [page([], "0")] }, "agents_invalid"],
  ] as const)("keeps the last copy on %s", async (_name, change, category) => {
    await expect(refresh()).resolves.toBe("succeeded");
    if ("agentStatus" in change) served.agentStatus = change.agentStatus;
    else served.agentPages = change.pages as unknown as Array<Record<string, unknown>>;

    await expect(refresh()).resolves.toBe("failed");
    const catalog = await db.discoveredSkillCatalog.findUniqueOrThrow({
      where: { resourceId: resource.id },
    });
    expect(catalog.lastFailureCategory).toBe(category);
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_intranet"]);
    expect((await listVisibleAgents(admin)).warnings).toContainEqual({
      source: key,
      code: "catalog_temporarily_unavailable",
    });
    expect((await listVisibleAgents(colleague)).warnings).toEqual([]);
  });

  it("hides agents of a stale catalog and of a resource with discovery switched off", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: { staleAfter: new Date("2000-01-01T00:00:00.000Z") },
    });
    expect(await listVisibleAgents(owner)).toMatchObject({
      items: [],
      warnings: [],
      registries: [],
    });
    expect((await listVisibleAgents(admin)).warnings).toContainEqual({
      source: key,
      code: "catalog_expired",
    });

    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleAgents(owner)).items).toHaveLength(1);
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { agentDiscoveryEnabled: false },
    });
    expect((await listVisibleAgents(owner)).items).toEqual([]);
    await expect(refresh()).resolves.toBe("unavailable");
  });

  it("lists discovered agents for administrators without their instructions", async () => {
    served.agentPages = [
      page([
        agent(),
        agent({
          id: "agt_old",
          name: "Archive",
          owner: `gone-${id}`,
          scopes: [salesScope],
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      ]),
    ];
    await expect(refresh()).resolves.toBe("succeeded");

    const all = await listDiscoveredAgents({ page: 1, pageSize: 20, source: resource.id });
    expect(all.total).toBe(2);
    expect(all.items).toEqual([
      {
        id: `${key}.agt_old`,
        name: "Archive",
        description: "Answers questions about the intranet",
        ownerId: `gone-${id}`,
        ownerName: null,
        ownerEmail: null,
        scopes: [salesScope],
        revision: 3,
        updatedAt: "2026-11-20T10:00:00.000Z",
        expiresAt: "2020-01-01T00:00:00.000Z",
        expired: true,
        resource: { id: resource.id, key, name: "Agent catalog test" },
      },
      expect.objectContaining({
        id: `${key}.agt_intranet`,
        ownerName: "Olivia Owner",
        ownerEmail: owner.email,
        scopes: [intranetScope, salesScope],
        expired: false,
      }),
    ]);
    expect(JSON.stringify(all)).not.toContain("Read the intranet pages");

    const found = await listDiscoveredAgents({
      page: 1,
      pageSize: 20,
      q: "archive",
      source: resource.id,
    });
    expect(found.items.map((item) => item.name)).toEqual(["Archive"]);
    const byScope = await listDiscoveredAgents({ page: 1, pageSize: 20, q: intranetScope });
    expect(byScope.items.map((item) => item.name)).toEqual(["Intranet helper"]);
    const paged = await listDiscoveredAgents({ page: 2, pageSize: 1, source: resource.id });
    expect(paged).toMatchObject({ total: 2, items: [{ name: "Intranet helper" }] });

    // Switched off: nothing is listed, although the copy is still stored.
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { agentDiscoveryEnabled: false },
    });
    expect((await listDiscoveredAgents({ page: 1, pageSize: 20, source: resource.id })).total).toBe(
      0,
    );
  });

  it("parses a page strictly", () => {
    expect(parseAgentCatalogPage(page([agent()]), resourceIdentifier).agents[0]).toMatchObject({
      id: "agt_intranet",
      updatedAt: new Date("2026-11-20T10:00:00.000Z"),
    });
    for (const broken of [
      page([agent({ id: "has space" })]),
      page([agent({ owner: "" })]),
      page([agent({ scopes: [intranetScope, intranetScope] })]),
      page([agent({ config: { format: "weldall-agent", version: 1 } })]),
      page([agent({ config: { format: "weldall-agent", version: 1, definition: [] } })]),
      page([agent({ revision: 0 })]),
      page([agent({ updatedAt: "yesterday" })]),
      { ...page([]), schemaVersion: 2 },
      { ...page([]), extra: true },
    ])
      expect(() => parseAgentCatalogPage(broken, resourceIdentifier)).toThrow();
  });
});
