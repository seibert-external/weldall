import { randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import { sideReloadFailureDetail } from "../src/app/admin/resources/catalog-reload.js";
import { getResource, updateResource } from "../src/server/admin/service.js";
import { parseAgentCatalogPage } from "../src/server/agents/discovery.js";
import {
  agentContent,
  agentsOffered,
  getVisibleAgent,
  listDiscoveredAgents,
  listVisibleAgents,
} from "../src/server/agents/service.js";
import { refreshResourceCatalog } from "../src/server/skills/catalogs.js";
import { listVisibleSkills } from "../src/server/skills/service.js";

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
  createdAt: "2026-10-01T08:00:00.000Z",
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

/** An object `depth` levels deep, counted as `config.definition` is (the object itself is 1). */
const nested = (depth: number): Record<string, unknown> => {
  let value: Record<string, unknown> = { leaf: true };
  for (let level = 1; level < depth; level += 1) value = { next: value };
  return value;
};
const page = (agents: unknown[], nextCursor?: string) => ({
  schemaVersion: 1,
  resource: resourceIdentifier,
  agents,
  ...(nextCursor === undefined ? {} : { nextCursor }),
});
const refresh = () => refreshResourceCatalog(resource.id, { fetcher });
const agentReloadFailureDetail = (dto: Parameters<typeof sideReloadFailureDetail>[0]) =>
  sideReloadFailureDetail(dto, ["agents"]);
const storedAgents = () =>
  db.discoveredAgent.findMany({
    where: { catalog: { resourceId: resource.id } },
    orderBy: { localId: "asc" },
  });
const storedCatalog = () =>
  db.discoveredSkillCatalog.findUniqueOrThrow({ where: { resourceId: resource.id } });
const switchSkills = (skillDiscoveryEnabled: boolean) =>
  db.downstreamResource.update({
    where: { id: resource.id },
    data: { skillDiscoveryEnabled },
  });
const visibleSkillIds = async (email: string) =>
  (await listVisibleSkills(email)).items
    .map((skill) => skill.slug)
    .filter((slug) => slug.startsWith(`${key}.`));

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
        sourceCreatedAt: new Date("2026-10-01T08:00:00.000Z"),
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
          createdAt: "2026-10-01T08:00:00.000Z",
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
    // An address elsewhere, or half an entry, fails the agent side like other broken metadata.
    served.agentApi = { ...api, endpoint: "https://elsewhere.example.com/api/agents" };
    await expect(refresh()).resolves.toBe("agents_failed");
    expect(await storedCatalog()).toMatchObject({
      lastFailureCategory: null,
      agentsLastFailureCategory: "agents_metadata_invalid",
    });
    served.agentApi = { endpoint: api.endpoint };
    await expect(refresh()).resolves.toBe("agents_failed");
    await db.resourceScope.deleteMany({ where: { resourceId: resource.id } });
  });

  it("opens one agent only for a person who may use it, and reads the format it knows", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    const agentId = `${key}.agt_intranet`;
    expect(await getVisibleAgent(colleague, agentId)).toMatchObject({ id: agentId, own: false });
    expect(await getVisibleAgent(stranger, agentId)).toBeNull();
    expect(await getVisibleAgent(owner, `${key}.agt_missing`)).toBeNull();

    expect(agentContent({ format: "weldall-agent", version: 1, definition })).toEqual({
      instructions: "Read the intranet pages before you answer.",
      prompt: null,
      starters: ["What is new this week?"],
      inputs: [],
      chosen: null,
    });
    expect(
      agentContent({
        format: "weldall-agent",
        version: 1,
        definition: {
          instructions: "",
          prompt: "Go.",
          inputs: [{ key: "topic", description: "Topic", type: "string" }, "broken"],
          tools: { mode: "selected", skills: ["intranet.search", 3], connections: [] },
        },
      }),
    ).toEqual({
      instructions: "",
      prompt: "Go.",
      starters: [],
      inputs: [{ key: "topic", description: "Topic" }],
      chosen: { skills: ["intranet.search"], connections: [] },
    });
    // Another format or version is listed without its content.
    expect(agentContent({ format: "other", version: 1, definition })).toBeNull();
    expect(agentContent({ format: "weldall-agent", version: 2, definition })).toBeNull();
    expect(agentContent({ format: "weldall-agent", version: 1, definition: "text" })).toBeNull();
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
    expect(await storedCatalog()).toMatchObject({
      agentsLastSuccessfulRefreshAt: null,
      agentsStaleAfter: null,
      agentsLastFailureCategory: null,
      agentsSkippedCount: 0,
      agentApiEndpoint: null,
    });
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

  it("keeps the skills online when the resource names no agent endpoint", async () => {
    served.skillsEndpoint = true;
    await switchSkills(true);
    await expect(refresh()).resolves.toBe("succeeded");
    served.agentPages = null;

    await expect(refresh()).resolves.toBe("agents_failed");
    const catalog = await storedCatalog();
    const { version } = await db.downstreamResource.findUniqueOrThrow({
      where: { id: resource.id },
    });
    // The skill side succeeded as it would without agents.
    expect(catalog).toMatchObject({
      lastFailureCategory: null,
      retryCount: 0,
      sourceResourceVersion: version,
      agentsLastFailureCategory: "agents_metadata_invalid",
    });
    expect(catalog.agentsLastFailureAt).toEqual(catalog.lastSuccessfulRefreshAt);
    expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
    expect((await listVisibleSkills(admin.email)).warnings).not.toContainEqual(
      expect.objectContaining({ source: key }),
    );
    // The agents keep their last copy and are still shown while it is younger than a day.
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_intranet"]);
    expect((await listVisibleAgents(colleague)).items).toHaveLength(1);
    expect((await listVisibleAgents(admin)).warnings).toContainEqual({
      source: key,
      code: "catalog_temporarily_unavailable",
    });

    // Once the agents can be read again, the failure is cleared.
    served.agentPages = [page([agent()])];
    await expect(refresh()).resolves.toBe("succeeded");
    expect(await storedCatalog()).toMatchObject({
      agentsLastFailureCategory: null,
      agentsLastFailureAt: null,
    });
    expect((await listVisibleAgents(admin)).warnings).toEqual([]);
  });

  it("keeps showing skills but hides agents read before the resource was changed", async () => {
    served.skillsEndpoint = true;
    await switchSkills(true);
    await expect(refresh()).resolves.toBe("succeeded");
    const changed = await db.downstreamResource.update({
      where: { id: resource.id },
      data: { version: { increment: 1 } },
    });
    served.agentStatus = 503;

    await expect(refresh()).resolves.toBe("agents_failed");
    expect(await storedCatalog()).toMatchObject({
      sourceResourceVersion: changed.version,
      agentsSourceResourceVersion: changed.version - 1,
      agentsLastFailureCategory: "agents_unavailable",
    });
    expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
    expect((await listVisibleAgents(colleague)).items).toEqual([]);
    expect((await listVisibleAgents(admin)).warnings).toContainEqual({
      source: key,
      code: "catalog_expired",
    });
    expect(
      (await listDiscoveredAgents({ page: 1, pageSize: 20, source: resource.id })).items,
    ).toMatchObject([{ id: `${key}.agt_intranet`, catalogState: "expired" }]);

    served.agentStatus = 200;
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleAgents(colleague)).items).toHaveLength(1);
  });

  it("fails the skill side as it would without agents, and keeps the agents", async () => {
    served.skillsEndpoint = true;
    await switchSkills(true);
    await expect(refresh()).resolves.toBe("succeeded");
    // The resource stops naming its skill catalog: broken metadata for the skill side.
    served.skillsEndpoint = false;

    await expect(refresh()).resolves.toBe("failed");
    expect(await storedCatalog()).toMatchObject({
      lastFailureCategory: "metadata_invalid",
      agentsLastFailureCategory: null,
    });
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_intranet"]);
    // Neither side was read: administrators are told the agents are not current.
    expect((await listVisibleAgents(admin)).warnings).toContainEqual({
      source: key,
      code: "catalog_temporarily_unavailable",
    });
  });

  it.each([
    ["an unreachable endpoint", { agentStatus: 503 }, "agents_unavailable"],
    ["a refused assertion", { agentStatus: 401 }, "agents_unauthorized"],
    ["another resource's page", { pages: [{ ...page([]), resource: origin }] }, "agents_invalid"],
    ["a page with an unknown field", { pages: [{ ...page([]), extra: 1 }] }, "agents_invalid"],
    ["a page that is no JSON object", { pages: [[agent()]] }, "agents_invalid"],
    ["the same agent twice", { pages: [page([agent()], "1"), page([agent()])] }, "agents_invalid"],
    ["a cursor that repeats", { pages: [page([], "0")] }, "agents_invalid"],
  ] as const)(
    "keeps the last copy of the agents and the skills on %s",
    async (_name, change, category) => {
      served.skillsEndpoint = true;
      await switchSkills(true);
      await expect(refresh()).resolves.toBe("succeeded");
      if ("agentStatus" in change) served.agentStatus = change.agentStatus;
      else served.agentPages = change.pages as unknown as Array<Record<string, unknown>>;

      await expect(refresh()).resolves.toBe("agents_failed");
      expect(await storedCatalog()).toMatchObject({
        lastFailureCategory: null,
        agentsLastFailureCategory: category,
      });
      expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
      expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_intranet"]);
      expect((await listVisibleAgents(admin)).warnings).toContainEqual({
        source: key,
        code: "catalog_temporarily_unavailable",
      });
      expect((await listVisibleAgents(colleague)).warnings).toEqual([]);
    },
  );

  it("leaves out an agent that fails validation and stores the others", async () => {
    served.agentPages = [
      page(
        [
          agent({ id: "agt_long", description: "x".repeat(1_001) }),
          // Values the columns cannot hold are left out, not passed on to fail the write.
          agent({ id: "agt_big_revision", revision: 2_147_483_648 }),
          agent({
            id: "agt_big_version",
            config: { format: "weldall-agent", version: 3_000_000_000, definition },
          }),
          agent({ id: "agt_nul", name: "a\u0000b" }),
          agent({ id: "agt_bad_scope", scopes: ["Everyone"] }),
          agent({
            id: "agt_many_scopes",
            scopes: Array.from({ length: 101 }, (_, index) => `agenttest${id}:s${index}`),
          }),
          agent({ id: "agt_ok_too", name: "Second" }),
        ],
        "1",
      ),
      page([agent(), (({ expiresAt: _, ...rest }) => rest)(agent({ id: "agt_no_expiry" }))]),
    ];

    await expect(refresh()).resolves.toBe("succeeded");
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual([
      "agt_intranet",
      "agt_ok_too",
    ]);
    expect(await storedCatalog()).toMatchObject({
      agentsSkippedCount: 7,
      agentsLastFailureCategory: null,
    });
    expect((await listVisibleAgents(admin)).warnings).toEqual([
      { source: key, code: "agents_skipped", count: 7 },
    ]);
    expect((await listVisibleAgents(colleague)).warnings).toEqual([]);
    expect((await listVisibleAgents(colleague)).items).toHaveLength(2);

    // The count is the last refresh's.
    served.agentPages = [page([agent()])];
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await storedCatalog()).agentsSkippedCount).toBe(0);
    expect((await listVisibleAgents(admin)).warnings).toEqual([]);
  });

  it("stores the skills and keeps the last copy of the agents when they cannot be stored", async () => {
    served.skillsEndpoint = true;
    await switchSkills(true);
    // The largest values the columns hold are stored.
    served.agentPages = [
      page([
        agent({
          revision: 2_147_483_647,
          config: { format: "weldall-agent", version: 2_147_483_647, definition: nested(64) },
        }),
      ]),
    ];
    await expect(refresh()).resolves.toBe("succeeded");
    const before = await storedCatalog();
    const skillsBefore = await db.discoveredSkill.findMany({ where: { catalogId: before.id } });
    // The database refuses an agent that validation let through: an unexpected write error.
    const refuse = `agent_test_refuse_${id}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION "${refuse}"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$ LANGUAGE plpgsql`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${refuse}" BEFORE INSERT ON "DiscoveredAgent" FOR EACH ROW WHEN (NEW."name" = 'Refused') EXECUTE FUNCTION "${refuse}"()`,
    );
    try {
      served.agentPages = [
        page([agent({ id: "agt_new" }), agent({ id: "agt_refused", name: "Refused" })]),
      ];
      await expect(refresh()).resolves.toBe("agents_failed");
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "${refuse}" ON "DiscoveredAgent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${refuse}"()`);
    }

    const after = await storedCatalog();
    // The skill side was written as on any successful refresh ...
    expect(after).toMatchObject({
      lastFailureCategory: null,
      retryCount: 0,
      agentsLastFailureCategory: "refresh_internal_error",
      agentsLastSuccessfulRefreshAt: before.agentsLastSuccessfulRefreshAt,
    });
    expect(after.lastSuccessfulRefreshAt!.getTime()).toBeGreaterThan(
      before.lastSuccessfulRefreshAt!.getTime(),
    );
    const skillsAfter = await db.discoveredSkill.findMany({ where: { catalogId: before.id } });
    expect(skillsAfter.map((skill) => skill.localId)).toEqual(["howto"]);
    expect(skillsAfter[0]!.id).not.toBe(skillsBefore[0]!.id);
    expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
    // ... and the agent part was rolled back as a whole: the last copy stays and is shown.
    expect(await storedAgents()).toMatchObject([
      { localId: "agt_intranet", revision: 2_147_483_647 },
    ]);
    expect((await listVisibleAgents(colleague)).items).toHaveLength(1);
    expect((await listVisibleAgents(admin)).warnings).toContainEqual({
      source: key,
      code: "catalog_temporarily_unavailable",
    });
  });

  it("fails the agent side when every published agent is invalid, and keeps the last copy", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    const before = await storedCatalog();
    // A systematic mismatch: the resource does not send a field Weldall requires.
    const { createdAt: _, ...withoutCreatedAt } = agent();
    served.agentPages = [page([withoutCreatedAt, { ...withoutCreatedAt, id: "agt_second" }])];

    await expect(refresh()).resolves.toBe("agents_failed");
    const after = await storedCatalog();
    expect(after).toMatchObject({
      agentsLastFailureCategory: "agents_all_invalid",
      agentsLastSuccessfulRefreshAt: before.agentsLastSuccessfulRefreshAt,
      agentsSkippedCount: 0,
      // Agents only: the agent side is the whole refresh and is retried like a failed one.
      lastFailureCategory: null,
      lastSuccessfulRefreshAt: before.lastSuccessfulRefreshAt,
      retryCount: 1,
    });
    expect(after.nextRefreshAt.getTime() - after.lastAttemptAt!.getTime()).toBe(30_000);
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_intranet"]);
    expect((await listVisibleAgents(colleague)).items).toHaveLength(1);
    const dto = await getResource(resource.id);
    expect(dto.catalogStatus).toMatchObject({
      state: "failed",
      agentCount: 1,
      agents: { state: "failed", lastFailureCategory: "agents_all_invalid" },
    });
    expect(agentReloadFailureDetail(dto)).toBe(
      "People keep seeing the last copy of the agents. See the agent discovery status for details",
    );

    // A resource that publishes no agents at all is not a failure.
    served.agentPages = [page([])];
    await expect(refresh()).resolves.toBe("succeeded");
    expect(await storedAgents()).toEqual([]);
    expect(await storedCatalog()).toMatchObject({ retryCount: 0, agentsLastFailureCategory: null });
    expect((await getResource(resource.id)).catalogStatus).toMatchObject({
      state: "fresh",
      agents: { state: "fresh" },
    });
  });

  it("shows a first refresh whose agent side fails as failed, with nothing to show", async () => {
    await db.discoveredSkillCatalog.delete({ where: { resourceId: resource.id } });
    await db.resourceScope.create({
      data: { resourceId: resource.id, scopeId: scopeIds[salesScope]! },
    });
    served.agentApi = { endpoint: `${origin}/api/agents`, scope: salesScope };
    served.agentStatus = 503;
    try {
      await expect(refresh()).resolves.toBe("agents_failed");
      expect(await storedAgents()).toEqual([]);
      expect(await storedCatalog()).toMatchObject({
        lastSuccessfulRefreshAt: null,
        agentsLastSuccessfulRefreshAt: null,
        agentsLastFailureCategory: "agents_unavailable",
        agentApiEndpoint: null,
      });
      const dto = await getResource(resource.id);
      expect(dto.catalogStatus).toMatchObject({
        state: "failed",
        agentCount: 0,
        lastSuccessfulRefreshAt: null,
        agents: {
          state: "failed",
          lastSuccessfulRefreshAt: null,
          lastFailureCategory: "agents_unavailable",
        },
      });
      expect(agentReloadFailureDetail(dto)).toBe(
        "No agents have been read from this resource yet. See the agent discovery status for details",
      );
      expect(await listVisibleAgents(colleague)).toMatchObject({ items: [], registries: [] });
      expect((await listVisibleAgents(admin)).warnings).toContainEqual({
        source: key,
        code: "catalog_temporarily_unavailable",
      });

      // With skills as well, the skills are stored and the agent side alone is failed.
      served.skillsEndpoint = true;
      await switchSkills(true);
      await expect(refresh()).resolves.toBe("agents_failed");
      const both = await getResource(resource.id);
      expect(both.catalogStatus).toMatchObject({
        state: "fresh",
        skillCount: 1,
        agents: { state: "failed", lastSuccessfulRefreshAt: null },
      });
      expect(agentReloadFailureDetail(both)).toBe(
        "The skills were reloaded. No agents have been read from this resource yet. See the agent discovery status for details",
      );
      expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
    } finally {
      await db.resourceScope.deleteMany({ where: { resourceId: resource.id } });
    }
  });

  it("hides the agents after the switch was off until they are read again", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    const actor = { id: admin.id, email: admin.email, requestId: `agent-test-${id}` };
    const save = (
      current: Awaited<ReturnType<typeof getResource>>,
      agentDiscoveryEnabled: boolean,
    ) =>
      updateResource(
        {
          id: current.id,
          name: current.name,
          authorizationServer: current.authorizationServer,
          downstreamClientId: current.downstreamClientId,
          enabled: true,
          skillDiscoveryEnabled: false,
          agentDiscoveryEnabled,
          scopeIds: current.scopeIds,
          requestPrefixes: [`${origin}/api`],
          expectedVersion: current.version,
        },
        actor,
      );
    const fresh = await getResource(resource.id);
    expect(fresh.catalogStatus).toMatchObject({ state: "fresh", agents: { state: "fresh" } });

    const off = await save(fresh, false);
    expect(off).toMatchObject({
      version: fresh.version + 1,
      catalogStatus: { state: "disabled", agentCount: 0, agents: null },
    });
    expect((await listVisibleAgents(owner)).items).toEqual([]);
    // Switched on again before any refresh: the copy is from before the change and stays hidden.
    const on = await save(off, true);
    expect(on).toMatchObject({
      version: fresh.version + 2,
      catalogStatus: { state: "expired", agents: { state: "expired" } },
    });
    expect((await listVisibleAgents(owner)).items).toEqual([]);
    expect((await listVisibleAgents(admin)).warnings).toContainEqual({
      source: key,
      code: "catalog_expired",
    });

    // A failed read does not bring it back ...
    served.agentStatus = 503;
    await expect(refresh()).resolves.toBe("agents_failed");
    const failed = await getResource(resource.id);
    expect(failed.catalogStatus).toMatchObject({ state: "expired", agents: { state: "expired" } });
    expect(agentReloadFailureDetail(failed)).toBe(
      "The last copy of the agents stays hidden until they can be read again. See the agent discovery status for details",
    );
    expect((await listVisibleAgents(owner)).items).toEqual([]);
    // ... a successful one does.
    served.agentStatus = 200;
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await getResource(resource.id)).catalogStatus).toMatchObject({ state: "fresh" });
    expect((await listVisibleAgents(owner)).items).toHaveLength(1);
  });

  it("hides agents of a stale catalog and of a resource with discovery switched off", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: { agentsStaleAfter: new Date("2000-01-01T00:00:00.000Z") },
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
        createdAt: "2026-10-01T08:00:00.000Z",
        updatedAt: "2026-11-20T10:00:00.000Z",
        expiresAt: "2020-01-01T00:00:00.000Z",
        expired: true,
        resource: { id: resource.id, key, name: "Agent catalog test" },
        catalogState: "fresh",
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

    // A copy people no longer see is still listed, and says so per row.
    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: { agentsStaleAfter: new Date("2000-01-01T00:00:00.000Z") },
    });
    expect(
      (await listDiscoveredAgents({ page: 1, pageSize: 20, source: resource.id })).items.map(
        (item) => item.catalogState,
      ),
    ).toEqual(["expired", "expired"]);
    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: {
        agentsStaleAfter: new Date("2100-01-01T00:00:00.000Z"),
        agentsLastFailureCategory: "agents_unavailable",
      },
    });
    expect(
      (await listDiscoveredAgents({ page: 1, pageSize: 20, source: resource.id })).items[0],
    ).toMatchObject({ catalogState: "failed" });

    // Switched off: nothing is listed, although the copy is still stored.
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { agentDiscoveryEnabled: false },
    });
    expect((await listDiscoveredAgents({ page: 1, pageSize: 20, source: resource.id })).total).toBe(
      0,
    );
  });

  it("parses a page strictly and each agent on its own", () => {
    // Fields Weldall does not know are ignored and not passed on, at both levels of an agent.
    const extended = parseAgentCatalogPage(
      page([
        agent({
          labels: ["new"],
          config: { format: "weldall-agent", version: 1, definition, checksum: "abc" },
        }),
      ]),
      resourceIdentifier,
    );
    expect(extended.skipped).toBe(0);
    expect(extended.agents[0]).not.toHaveProperty("labels");
    expect(extended.agents[0]!.config).toEqual({ format: "weldall-agent", version: 1, definition });
    // The largest values the columns hold, and a definition as deep as allowed, pass.
    expect(
      parseAgentCatalogPage(
        page([
          agent({
            revision: 2_147_483_647,
            config: { format: "weldall-agent", version: 2_147_483_647, definition: nested(64) },
          }),
        ]),
        resourceIdentifier,
      ).skipped,
    ).toBe(0);
    expect(parseAgentCatalogPage(page([agent()]), resourceIdentifier)).toMatchObject({
      skipped: 0,
      agents: [
        {
          id: "agt_intranet",
          createdAt: new Date("2026-10-01T08:00:00.000Z"),
          updatedAt: new Date("2026-11-20T10:00:00.000Z"),
        },
      ],
    });
    const { createdAt: _, ...withoutCreatedAt } = agent();
    for (const broken of [
      agent({ id: "has space" }),
      agent({ owner: "" }),
      agent({ scopes: [intranetScope, intranetScope] }),
      agent({ config: { format: "weldall-agent", version: 1 } }),
      agent({ config: { format: "weldall-agent", version: 1, definition: [] } }),
      agent({ revision: 0 }),
      agent({ updatedAt: "yesterday" }),
      withoutCreatedAt,
      agent({ revision: 2_147_483_648 }),
      agent({ config: { format: "weldall-agent", version: 2_147_483_648, definition } }),
      agent({ description: "line\u0000break" }),
      agent({ owner: "\ud800" }),
      agent({ scopes: [`agenttest${id}:${"s".repeat(200)}`] }),
      agent({ config: { format: "weldall-agent", version: 1, definition: { a: ["x\u0000"] } } }),
      agent({ config: { format: "weldall-agent", version: 1, definition: { "k\u0000": 1 } } }),
      agent({ config: { format: "weldall-agent", version: 1, definition: nested(65) } }),
      "not an agent",
    ])
      expect(
        parseAgentCatalogPage(page([agent({ id: "agt_ok" }), broken]), resourceIdentifier),
      ).toMatchObject({ skipped: 1, agents: [{ id: "agt_ok" }] });
    for (const broken of [
      { ...page([]), schemaVersion: 2 },
      { ...page([]), extra: true },
      { ...page([]), agents: "none" },
      { ...page([]), agents: Array.from({ length: 501 }, () => agent()) },
      [],
    ])
      expect(() => parseAgentCatalogPage(broken, resourceIdentifier)).toThrow();
  });
});
