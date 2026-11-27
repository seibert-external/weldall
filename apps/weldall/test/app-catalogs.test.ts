import { randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import { failedSides, sideReloadFailureDetail } from "../src/app/admin/resources/catalog-reload.js";
import { getResource } from "../src/server/admin/service.js";
import { listVisibleAgents } from "../src/server/agents/service.js";
import { parseAppCatalogPage } from "../src/server/apps/discovery.js";
import { httpsHref } from "../src/server/apps/href.js";
import {
  appsOffered,
  getVisibleApp,
  listDiscoveredApps,
  listVisibleApps,
  ownerLabel,
} from "../src/server/apps/service.js";
import { logger } from "../src/server/observability/logger.js";
import { REFRESH_TIMING, refreshResourceCatalog } from "../src/server/skills/catalogs.js";
import { listVisibleSkills } from "../src/server/skills/service.js";

const id = randomUUID().replaceAll("-", "");
const key = `apptest-${id}`;
const origin = `https://${key}.example`;
const resourceIdentifier = `${origin}/api`;
const metadataUrl = `${origin}/.well-known/oauth-protected-resource/api`;
const skillsEndpoint = `${origin}/.well-known/weldall-skills`;
const agentsEndpoint = `${origin}/.well-known/weldall-agents`;
const appsEndpoint = `${origin}/.well-known/weldall-apps`;
const by = "app-catalog-test";

const intranetScope = `apptest${id}:intranet`;
const salesScope = `apptest${id}:sales`;
const owner = { id: `owner-${id}`, email: `${id}-owner@example.com` };
const colleague = { id: `colleague-${id}`, email: `${id}-colleague@example.com` };
const stranger = { id: `stranger-${id}`, email: `${id}-stranger@example.com` };
const admin = { id: `admin-${id}`, email: `${id}-admin@example.com` };

const app = (overrides: Record<string, unknown> = {}) => ({
  id: "app_expenses",
  name: "Expense tracker",
  description: "Tracks travel expenses until they are booked",
  owner: owner.id,
  scopes: [intranetScope, salesScope],
  repository: { name: "finance/expense-tracker", url: "https://git.example.com/finance/expenses" },
  url: "https://expenses.apps.example.com/",
  revision: 4,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
  ...overrides,
});
const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "agt_intranet",
  name: "Intranet helper",
  description: "Answers questions about the intranet",
  owner: owner.id,
  scopes: [salesScope],
  config: { format: "weldall-agent", version: 1, definition: { instructions: "Help." } },
  revision: 1,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
  ...overrides,
});

/** What the resource serves; tests replace it. `*Pages: null` drops that endpoint. */
const served: {
  appPages: Array<Record<string, unknown>> | null;
  appStatus: number;
  agentPages: Array<Record<string, unknown>> | null;
  agentStatus: number;
  skillsEndpoint: boolean;
  appsEndpoint?: string;
} = { appPages: [], appStatus: 200, agentPages: null, agentStatus: 200, skillsEndpoint: false };
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
      ...(served.appPages ? { weldall_apps_endpoint: served.appsEndpoint ?? appsEndpoint } : {}),
    });
  if (url.toString() === skillsEndpoint)
    return Response.json({
      schemaVersion: 1,
      resource: resourceIdentifier,
      skills: [
        {
          id: "howto",
          title: "How to register an app",
          requiredScopes: [],
          visibility: "DEFAULT",
          content: "# How to register an app",
        },
      ],
    });
  const path = `${url.origin}${url.pathname}`;
  const cursor = url.searchParams.get("cursor");
  if (path === agentsEndpoint) {
    if (served.agentStatus !== 200) return new Response(null, { status: served.agentStatus });
    return Response.json(served.agentPages![cursor === null ? 0 : Number(cursor)]);
  }
  if (path === appsEndpoint) {
    assertions.push(new Headers(init?.headers).get("authorization")!.replace(/^Bearer /, ""));
    if (served.appStatus !== 200) return new Response(null, { status: served.appStatus });
    return Response.json(served.appPages![cursor === null ? 0 : Number(cursor)]);
  }
  return new Response(null, { status: 404 });
}) as unknown as typeof fetch;

const page = (apps: unknown[], nextCursor?: string) => ({
  schemaVersion: 1,
  resource: resourceIdentifier,
  apps,
  ...(nextCursor === undefined ? {} : { nextCursor }),
});
const agentPage = (agents: unknown[]) => ({
  schemaVersion: 1,
  resource: resourceIdentifier,
  agents,
});
const refresh = () => refreshResourceCatalog(resource.id, { fetcher });
const storedApps = () =>
  db.discoveredApp.findMany({
    where: { catalog: { resourceId: resource.id } },
    orderBy: { localId: "asc" },
  });
const storedAgents = () =>
  db.discoveredAgent.findMany({ where: { catalog: { resourceId: resource.id } } });
const storedCatalog = () =>
  db.discoveredSkillCatalog.findUniqueOrThrow({ where: { resourceId: resource.id } });
const switches = (data: {
  skillDiscoveryEnabled?: boolean;
  agentDiscoveryEnabled?: boolean;
  appDiscoveryEnabled?: boolean;
}) => db.downstreamResource.update({ where: { id: resource.id }, data });
const visibleSkillIds = async (email: string) =>
  (await listVisibleSkills(email)).items
    .map((skill) => skill.slug)
    .filter((slug) => slug.startsWith(`${key}.`));
/**
 * Makes the database refuse every row of `table` named "Refused", as a value validation let through
 * would be refused; returns what removes it again.
 */
const refuseInserts = async (table: "DiscoveredAgent" | "DiscoveredApp") => {
  const refuse = `app_test_refuse_${table}_${id}`;
  await db.$executeRawUnsafe(
    `CREATE FUNCTION "${refuse}"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$ LANGUAGE plpgsql`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER "${refuse}" BEFORE INSERT ON "${table}" FOR EACH ROW WHEN (NEW."name" = 'Refused') EXECUTE FUNCTION "${refuse}"()`,
  );
  return async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER "${refuse}" ON "${table}"`);
    await db.$executeRawUnsafe(`DROP FUNCTION "${refuse}"()`);
  };
};
/** Wraps `fetcher` so that requests to `endpoint` are answered by `answer` instead. */
const intercepting = (
  answers: Record<string, (signal: AbortSignal | undefined) => Promise<Response>>,
) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const answer = answers[`${url.origin}${url.pathname}`];
    if (!answer) return fetcher(input, init);
    requested.push(`${url.origin}${url.pathname}`);
    return answer(init?.signal ?? undefined);
  }) as typeof fetch;
/** Answers after `ms`, or rejects when the request is aborted first, as `fetch` does. */
const slowly =
  (ms: number, respond: () => Promise<Response>) => (signal: AbortSignal | undefined) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(respond()), ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
/** Skills, agents and apps on, and each read once. */
const allThreeRead = async () => {
  served.skillsEndpoint = true;
  served.agentPages = [agentPage([agent()])];
  await switches({ skillDiscoveryEnabled: true, agentDiscoveryEnabled: true });
  await expect(refresh()).resolves.toBe("succeeded");
};

const priorSigningEnv = {
  kid: process.env.WELDALL_SIGNING_KID,
  privateJwk: process.env.WELDALL_SIGNING_PRIVATE_JWK,
  publicJwk: process.env.WELDALL_SIGNING_PUBLIC_JWK,
};
const signingKey = await generateEs256KeyPair();
process.env.WELDALL_SIGNING_KID = `app-test-${id}`;
process.env.WELDALL_SIGNING_PRIVATE_JWK = JSON.stringify(signingKey.privateJwk);
process.env.WELDALL_SIGNING_PUBLIC_JWK = JSON.stringify(signingKey.publicJwk);

const resource = await db.downstreamResource.create({
  data: {
    key,
    name: "App catalog test",
    resourceIdentifier,
    authorizationServer: origin,
    downstreamClientId: `client-${key}`,
    enabled: true,
    // Apps only: the resource publishes no skill catalog and no agents.
    skillDiscoveryEnabled: false,
    agentDiscoveryEnabled: false,
    appDiscoveryEnabled: true,
    createdBy: by,
    updatedBy: by,
    discoveredCatalog: { create: {} },
  },
});
const scopeIds: Record<string, string> = {};
for (const scopeKey of [intranetScope, salesScope])
  scopeIds[scopeKey] = (
    await db.scope.create({
      data: { key: scopeKey, description: "App catalog test", createdBy: by, updatedBy: by },
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
// The owner holds no scope: owning the app is enough to see it.
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
  served.appPages = [page([app()])];
  served.appStatus = 200;
  served.agentPages = null;
  served.agentStatus = 200;
  served.skillsEndpoint = false;
  delete served.appsEndpoint;
  assertions.length = 0;
  requested.length = 0;
  await switches({
    skillDiscoveryEnabled: false,
    agentDiscoveryEnabled: false,
    appDiscoveryEnabled: true,
  });
  await db.discoveredSkillCatalog.update({
    where: { resourceId: resource.id },
    data: { refreshLeaseId: null, refreshLeaseUntil: null },
  });
});

describe("app discovery", () => {
  it("reads every page with its own signed assertion and stores the apps", async () => {
    served.appPages = [
      page([app()], "1"),
      page([app({ id: "app_bare", owner: null, scopes: [], repository: null, url: null })]),
    ];
    await expect(refresh()).resolves.toBe("succeeded");

    expect(await storedApps()).toMatchObject([
      { localId: "app_bare", ownerId: null, repositoryName: null, repositoryUrl: null, url: null },
      {
        localId: "app_expenses",
        canonicalId: `${key}.app_expenses`,
        name: "Expense tracker",
        description: "Tracks travel expenses until they are booked",
        ownerId: owner.id,
        scopes: [intranetScope, salesScope],
        repositoryName: "finance/expense-tracker",
        repositoryUrl: "https://git.example.com/finance/expenses",
        url: "https://expenses.apps.example.com/",
        revision: 4,
        sourceCreatedAt: new Date("2026-09-01T08:00:00.000Z"),
        sourceUpdatedAt: new Date("2026-11-20T10:00:00.000Z"),
        expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      },
    ]);
    expect(assertions).toHaveLength(2);
    expect(new Set(assertions).size).toBe(2);
    for (const assertion of assertions) {
      expect(decodeProtectedHeader(assertion)).toMatchObject({
        alg: "ES256",
        typ: "weldall-apps+jwt",
      });
      const claims = decodeJwt(assertion);
      expect(claims).toMatchObject({
        iss: claims.sub,
        aud: appsEndpoint,
        resource: resourceIdentifier,
        purpose: "apps:read",
      });
      expect(claims.exp! - claims.iat!).toBe(60);
    }
    // Neither skills nor agents are switched on: their endpoints are not asked for.
    expect(requested).not.toContain(skillsEndpoint);
    expect(requested).not.toContain(agentsEndpoint);
  });

  it("shows an app to its owner and to holders of any one of its scopes", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    const own = await listVisibleApps(owner);
    expect(own).toEqual({
      warnings: [],
      items: [
        {
          id: `${key}.app_expenses`,
          sourceId: "app_expenses",
          name: "Expense tracker",
          description: "Tracks travel expenses until they are booked",
          own: true,
          hasOwner: true,
          ownerName: "Olivia Owner",
          scopes: [intranetScope, salesScope],
          repository: {
            name: "finance/expense-tracker",
            url: "https://git.example.com/finance/expenses",
          },
          url: "https://expenses.apps.example.com/",
          revision: 4,
          createdAt: "2026-09-01T08:00:00.000Z",
          updatedAt: "2026-11-20T10:00:00.000Z",
          expiresAt: "2100-01-01T00:00:00.000Z",
          expired: false,
          source: { type: "resource", key, name: "App catalog test" },
        },
      ],
    });
    expect(ownerLabel(own.items[0]!)).toBe("You");
    const shared = await listVisibleApps(colleague);
    expect(shared.items).toMatchObject([{ own: false, ownerName: "Olivia Owner" }]);
    expect(ownerLabel(shared.items[0]!)).toBe("Olivia Owner");
    expect((await listVisibleApps(stranger)).items).toEqual([]);
    // Administering Weldall does not open an app in the directory; the admin list shows all.
    expect((await listVisibleApps(admin)).items).toEqual([]);
  });

  it("opens an app without owner to holders of its scopes, and one without both to nobody", async () => {
    served.appPages = [
      page([
        app({ id: "app_team", owner: null, repository: null }),
        app({ id: "app_orphan", owner: null, scopes: [] }),
        app({ id: "app_gone", owner: `gone-${id}`, scopes: [salesScope], url: null }),
      ]),
    ];
    await expect(refresh()).resolves.toBe("succeeded");
    const shared = (await listVisibleApps(colleague)).items;
    expect(shared.map((item) => item.sourceId)).toEqual(["app_gone", "app_team"]);
    expect(shared).toMatchObject([
      { hasOwner: true, ownerName: null, url: null },
      { hasOwner: false, ownerName: null, repository: null },
    ]);
    expect(shared.map(ownerLabel)).toEqual(["Unknown", "No owner"]);
    for (const person of [owner, stranger, admin])
      expect((await listVisibleApps(person)).items.map((item) => item.sourceId)).not.toContain(
        "app_orphan",
      );
    const listed = await listDiscoveredApps({ page: 1, pageSize: 20, source: resource.id });
    expect(listed.items.map((item) => item.id)).toContain(`${key}.app_orphan`);
  });

  it("never opens an app through one of Weldall's own permissions", async () => {
    served.appPages = [page([app({ owner: null, scopes: ["weldall:administer"] })])];
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleApps(admin)).items).toEqual([]);
    expect((await listVisibleApps(owner)).items).toEqual([]);
  });

  it("opens one app only for a person who may see it", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    const appId = `${key}.app_expenses`;
    expect(await getVisibleApp(colleague, appId)).toMatchObject({ id: appId, own: false });
    expect(await getVisibleApp(stranger, appId)).toBeNull();
    expect(await getVisibleApp(owner, `${key}.app_missing`)).toBeNull();
  });

  it("offers the Apps tab while a resource has app discovery switched on", async () => {
    expect(await appsOffered()).toBe(true);
    const others = await db.downstreamResource.count({
      where: { enabled: true, appDiscoveryEnabled: true, id: { not: resource.id } },
    });
    await switches({ appDiscoveryEnabled: false });
    expect(await appsOffered()).toBe(others > 0);
  });

  it("removes the apps when the switch is off and hides them until they are read again", async () => {
    served.skillsEndpoint = true;
    await switches({ skillDiscoveryEnabled: true });
    await expect(refresh()).resolves.toBe("succeeded");
    expect(await storedApps()).toHaveLength(1);
    await switches({ appDiscoveryEnabled: false });
    expect((await listVisibleApps(owner)).items).toEqual([]);
    expect((await listDiscoveredApps({ page: 1, pageSize: 20, source: resource.id })).total).toBe(
      0,
    );
    // The resource still names its app endpoint; it is not read.
    requested.length = 0;
    await expect(refresh()).resolves.toBe("succeeded");
    expect(requested).not.toContain(appsEndpoint);
    expect(await storedApps()).toEqual([]);
    expect(await storedCatalog()).toMatchObject({
      appsSourceResourceVersion: null,
      appsLastSuccessfulRefreshAt: null,
      appsStaleAfter: null,
      appsLastFailureCategory: null,
      appsSkippedCount: 0,
    });
    expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);

    await switches({ appDiscoveryEnabled: true });
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleApps(owner)).items).toHaveLength(1);
  });

  it("leaves out an app that fails validation and stores the others", async () => {
    served.appPages = [
      page([
        app({ id: "app_http", url: "http://expenses.example.com" }),
        app({ id: "app_script", url: "javascript:alert(1)" }),
        app({ id: "app_secret", repository: { name: "a/b", url: "https://u:p@git.example.com" } }),
        app({ id: "app_two_lines", name: "Expense\ntracker" }),
        app({ id: "app_nul", description: "a\u0000b" }),
        app({ id: "app_big", revision: 2_147_483_648 }),
        app({ id: "app_ok_too", name: "Second" }),
      ]),
    ];
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_ok_too"]);
    expect(await storedCatalog()).toMatchObject({ appsSkippedCount: 6 });
    expect((await listVisibleApps(admin)).warnings).toEqual([
      { source: key, code: "apps_skipped", count: 6 },
    ]);
    expect((await listVisibleApps(colleague)).warnings).toEqual([]);
  });

  it.each([
    ["no app endpoint in the metadata", { pages: null }, "apps_metadata_invalid"],
    [
      "an app endpoint elsewhere",
      { endpoint: "https://elsewhere.example.com/apps" },
      "apps_metadata_invalid",
    ],
    ["an unreachable endpoint", { status: 503 }, "apps_unavailable"],
    ["a refused assertion", { status: 403 }, "apps_unauthorized"],
    ["a page with an unknown field", { pages: [{ ...page([]), extra: 1 }] }, "apps_invalid"],
    ["the same app twice", { pages: [page([app()], "1"), page([app()])] }, "apps_invalid"],
    [
      "only invalid apps",
      { pages: [page([app({ url: "ftp://x.example.com" })])] },
      "apps_all_invalid",
    ],
  ] as const)(
    "keeps skills, agents and the last copy of the apps on %s",
    async (_name, change, category) => {
      await allThreeRead();
      if ("status" in change) served.appStatus = change.status;
      else if ("endpoint" in change) served.appsEndpoint = change.endpoint;
      else served.appPages = change.pages as unknown as Array<Record<string, unknown>> | null;

      await expect(refresh()).resolves.toBe("apps_failed");
      expect(await storedCatalog()).toMatchObject({
        lastFailureCategory: null,
        retryCount: 0,
        agentsLastFailureCategory: null,
        appsLastFailureCategory: category,
      });
      expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
      expect((await listVisibleAgents(colleague)).items).toHaveLength(1);
      expect((await listVisibleAgents(admin)).warnings).toEqual([]);
      expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_expenses"]);
      expect((await listVisibleApps(colleague)).items).toHaveLength(1);
      expect((await listVisibleApps(admin)).warnings).toContainEqual({
        source: key,
        code: "catalog_temporarily_unavailable",
      });
      const dto = await getResource(resource.id);
      expect(dto.catalogStatus).toMatchObject({
        state: "fresh",
        agents: { state: "fresh" },
        apps: { state: "failed", lastFailureCategory: category },
        appCount: 1,
      });
      expect(sideReloadFailureDetail(dto, failedSides("apps_failed"))).toBe(
        "The skills and agents were reloaded. People keep seeing the last copy of the apps. See the app discovery status for details",
      );
    },
  );

  it("stores the apps when the agents fail, and names both when both fail", async () => {
    await allThreeRead();
    served.agentStatus = 503;
    served.appPages = [page([app({ id: "app_new" })])];
    await expect(refresh()).resolves.toBe("agents_failed");
    expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_new"]);
    expect(await storedCatalog()).toMatchObject({
      agentsLastFailureCategory: "agents_unavailable",
      appsLastFailureCategory: null,
    });
    expect((await listVisibleApps(admin)).warnings).toEqual([]);

    served.appStatus = 503;
    await expect(refresh()).resolves.toBe("agents_and_apps_failed");
    expect(failedSides("agents_and_apps_failed")).toEqual(["agents", "apps"]);
    expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
    const dto = await getResource(resource.id);
    expect(sideReloadFailureDetail(dto, ["agents", "apps"])).toBe(
      "The skills were reloaded. People keep seeing the last copy of the agents. People keep seeing the last copy of the apps. See the agent and app discovery status for details",
    );
  });

  it("rolls back only the apps when they cannot be stored", async () => {
    await allThreeRead();
    const restore = await refuseInserts("DiscoveredApp");
    try {
      served.agentPages = [agentPage([agent({ id: "agt_new" })])];
      served.appPages = [
        page([app({ id: "app_new" }), app({ id: "app_refused", name: "Refused" })]),
      ];
      await expect(refresh()).resolves.toBe("apps_failed");
    } finally {
      await restore();
    }
    expect(await storedCatalog()).toMatchObject({
      lastFailureCategory: null,
      agentsLastFailureCategory: null,
      appsLastFailureCategory: "refresh_internal_error",
    });
    // The agents written before the apps in the same transaction stay ...
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_new"]);
    // ... and the apps are rolled back as a whole to their last copy.
    expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_expenses"]);
  });

  it("rolls back only the agents when they cannot be stored, and stores the apps", async () => {
    await allThreeRead();
    const before = await storedCatalog();
    const restore = await refuseInserts("DiscoveredAgent");
    try {
      served.agentPages = [
        agentPage([agent({ id: "agt_new" }), agent({ id: "agt_refused", name: "Refused" })]),
      ];
      served.appPages = [page([app({ id: "app_new" })])];
      await expect(refresh()).resolves.toBe("agents_failed");
    } finally {
      await restore();
    }
    const catalog = await storedCatalog();
    expect(catalog).toMatchObject({
      lastFailureCategory: null,
      retryCount: 0,
      agentsLastFailureCategory: "refresh_internal_error",
      appsLastFailureCategory: null,
    });
    // The skills were stored with this refresh ...
    expect(catalog.lastSuccessfulRefreshAt!.getTime()).toBeGreaterThan(
      before.lastSuccessfulRefreshAt!.getTime(),
    );
    expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
    // ... the agents are rolled back to their last copy, and the apps replaced.
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_intranet"]);
    expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_new"]);
  });

  it("keeps both last copies when neither agents nor apps can be stored", async () => {
    await allThreeRead();
    const before = await storedCatalog();
    const restoreAgents = await refuseInserts("DiscoveredAgent");
    const restoreApps = await refuseInserts("DiscoveredApp");
    try {
      served.agentPages = [agentPage([agent({ id: "agt_refused", name: "Refused" })])];
      served.appPages = [page([app({ id: "app_refused", name: "Refused" })])];
      await expect(refresh()).resolves.toBe("agents_and_apps_failed");
    } finally {
      await restoreApps();
      await restoreAgents();
    }
    const catalog = await storedCatalog();
    expect(catalog).toMatchObject({
      lastFailureCategory: null,
      retryCount: 0,
      agentsLastFailureCategory: "refresh_internal_error",
      appsLastFailureCategory: "refresh_internal_error",
    });
    expect(catalog.lastSuccessfulRefreshAt!.getTime()).toBeGreaterThan(
      before.lastSuccessfulRefreshAt!.getTime(),
    );
    expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_intranet"]);
    expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_expenses"]);
  });

  it("ends every read well before the lease, however many sides there are", () => {
    const timing = REFRESH_TIMING;
    // The sides share one deadline, the rest of the read budget: their number does not add up.
    // The metadata and the skill catalog leave them at least ten seconds of it ...
    expect(timing.readBudgetMs - 2 * timing.fetchTimeoutMs).toBeGreaterThanOrEqual(10_000);
    // ... and the reads plus the wait for a connection end at least five seconds before the lease,
    // when the transaction renews it as its first statement.
    expect(timing.readBudgetMs + timing.transactionMaxWaitMs).toBeLessThanOrEqual(
      timing.leaseMs - 5_000,
    );
    // From the renewal on, the transaction ends before the renewed lease would.
    expect(timing.transactionTimeoutMs).toBeLessThan(timing.leaseMs);
  });

  it("stores the skills when both side endpoints hang, and records both sides as failed", async () => {
    await allThreeRead();
    const before = await storedCatalog();
    const fetchHanging = intercepting({
      // One ignores its signal and never answers; the other answers too late and heeds its signal.
      [agentsEndpoint]: () => new Promise<Response>(() => {}),
      [appsEndpoint]: slowly(60_000, async () => Response.json(page([app({ id: "app_late" })]))),
    });
    const started = performance.now();
    await expect(
      refreshResourceCatalog(resource.id, { fetcher: fetchHanging, readBudgetMs: 300 }),
    ).resolves.toBe("agents_and_apps_failed");
    expect(performance.now() - started).toBeLessThan(5_000);
    const catalog = await storedCatalog();
    expect(catalog).toMatchObject({
      lastFailureCategory: null,
      retryCount: 0,
      agentsLastFailureCategory: "agents_unavailable",
      appsLastFailureCategory: "apps_unavailable",
    });
    expect(catalog.lastSuccessfulRefreshAt!.getTime()).toBeGreaterThan(
      before.lastSuccessfulRefreshAt!.getTime(),
    );
    expect(await visibleSkillIds(colleague.email)).toEqual([`${key}.howto`]);
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_intranet"]);
    expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_expenses"]);
  });

  it("reads the agents and the apps at the same time", async () => {
    await allThreeRead();
    // Each side takes 600 ms; one after another they would overrun the budget of 1000 ms.
    const fetchSlow = intercepting({
      [agentsEndpoint]: slowly(600, async () =>
        Response.json(agentPage([agent({ id: "agt_slow" })])),
      ),
      [appsEndpoint]: slowly(600, async () => Response.json(page([app({ id: "app_slow" })]))),
    });
    await expect(
      refreshResourceCatalog(resource.id, { fetcher: fetchSlow, readBudgetMs: 1_000 }),
    ).resolves.toBe("succeeded");
    expect((await storedAgents()).map((stored) => stored.localId)).toEqual(["agt_slow"]);
    expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_slow"]);
  });

  it("logs a refresh that lost its lease and records no failure for the resource", async () => {
    await allThreeRead();
    const before = await storedCatalog();
    const otherLease = randomUUID();
    // While the apps are read, the lease runs out and another refresh claims it.
    const fetchTakenOver = intercepting({
      [appsEndpoint]: async () => {
        await db.discoveredSkillCatalog.update({
          where: { resourceId: resource.id },
          data: { refreshLeaseId: otherLease, refreshLeaseUntil: new Date(Date.now() + 30_000) },
        });
        return Response.json(page([app({ id: "app_new" })]));
      },
    });
    const warn = vi.spyOn(logger, "warn");
    try {
      await expect(refreshResourceCatalog(resource.id, { fetcher: fetchTakenOver })).resolves.toBe(
        "failed",
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "skill_catalog.refresh.lease_lost",
          publisherId: resource.id,
          publisherKey: key,
          leaseMs: REFRESH_TIMING.leaseMs,
          readDurationMs: expect.any(Number),
          durationMs: expect.any(Number),
        }),
        "Skill, agent and app catalog refresh lost its lease before it could store what it read; nothing was stored",
      );
    } finally {
      warn.mockRestore();
    }
    // Nothing was stored and nothing recorded: the refresh that holds the lease now does that.
    const catalog = await storedCatalog();
    expect(catalog).toMatchObject({
      refreshLeaseId: otherLease,
      lastFailureCategory: null,
      retryCount: before.retryCount,
      lastAttemptAt: before.lastAttemptAt,
      agentsLastFailureCategory: null,
      appsLastFailureCategory: null,
    });
    expect((await storedApps()).map((stored) => stored.localId)).toEqual(["app_expenses"]);
  });

  it("retries a refresh without skills only when every other side failed", async () => {
    // Apps only, and they fail: the app side is the whole refresh.
    await expect(refresh()).resolves.toBe("succeeded");
    served.appStatus = 503;
    await expect(refresh()).resolves.toBe("apps_failed");
    expect(await storedCatalog()).toMatchObject({ retryCount: 1, lastFailureCategory: null });
    expect((await getResource(resource.id)).catalogStatus).toMatchObject({
      state: "failed",
      apps: { state: "failed" },
    });

    // Agents and apps, no skills: the agents are stored, so the refresh is not retried early.
    served.agentPages = [agentPage([agent()])];
    await switches({ agentDiscoveryEnabled: true });
    await expect(refresh()).resolves.toBe("apps_failed");
    const catalog = await storedCatalog();
    expect(catalog.retryCount).toBe(0);
    expect(catalog.nextRefreshAt.getTime() - catalog.lastAttemptAt!.getTime()).toBe(600_000);
    // The resource takes the state of the less healthy side.
    expect((await getResource(resource.id)).catalogStatus).toMatchObject({
      state: "failed",
      agents: { state: "fresh" },
      apps: { state: "failed" },
    });
    served.agentStatus = 503;
    await expect(refresh()).resolves.toBe("agents_and_apps_failed");
    expect((await storedCatalog()).retryCount).toBe(1);
  });

  it("hides the apps of a copy read before the resource was changed", async () => {
    await expect(refresh()).resolves.toBe("succeeded");
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { version: { increment: 1 } },
    });
    served.appStatus = 503;
    await expect(refresh()).resolves.toBe("apps_failed");
    expect((await listVisibleApps(owner)).items).toEqual([]);
    expect((await listVisibleApps(admin)).warnings).toContainEqual({
      source: key,
      code: "catalog_expired",
    });
    const dto = await getResource(resource.id);
    expect(sideReloadFailureDetail(dto, ["apps"])).toBe(
      "The last copy of the apps stays hidden until they can be read again. See the app discovery status for details",
    );
    expect(
      (await listDiscoveredApps({ page: 1, pageSize: 20, source: resource.id })).items,
    ).toMatchObject([{ catalogState: "expired" }]);
    served.appStatus = 200;
    await expect(refresh()).resolves.toBe("succeeded");
    expect((await listVisibleApps(owner)).items).toHaveLength(1);
  });

  it("lists every discovered app for administrators", async () => {
    served.appPages = [
      page([
        app(),
        app({
          id: "app_archive",
          name: "Archive",
          owner: null,
          scopes: [],
          repository: null,
          url: null,
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      ]),
    ];
    await expect(refresh()).resolves.toBe("succeeded");
    const all = await listDiscoveredApps({ page: 1, pageSize: 20, source: resource.id });
    expect(all).toEqual({
      total: 2,
      items: [
        {
          id: `${key}.app_archive`,
          name: "Archive",
          description: "Tracks travel expenses until they are booked",
          ownerId: null,
          ownerName: null,
          ownerEmail: null,
          scopes: [],
          repository: null,
          url: null,
          revision: 4,
          createdAt: "2026-09-01T08:00:00.000Z",
          updatedAt: "2026-11-20T10:00:00.000Z",
          expiresAt: "2020-01-01T00:00:00.000Z",
          expired: true,
          resource: { id: resource.id, key, name: "App catalog test" },
          catalogState: "fresh",
        },
        expect.objectContaining({
          id: `${key}.app_expenses`,
          ownerId: owner.id,
          ownerName: "Olivia Owner",
          ownerEmail: owner.email,
          repository: {
            name: "finance/expense-tracker",
            url: "https://git.example.com/finance/expenses",
          },
          url: "https://expenses.apps.example.com/",
          expired: false,
        }),
      ],
    });
    const byRepository = await listDiscoveredApps({ page: 1, pageSize: 20, q: "EXPENSE-TRACKER" });
    expect(byRepository.items.map((item) => item.name)).toEqual(["Expense tracker"]);
    const paged = await listDiscoveredApps({ page: 2, pageSize: 1, source: resource.id });
    expect(paged).toMatchObject({ total: 2, items: [{ name: "Expense tracker" }] });
  });

  it("parses a page strictly and each app on its own", () => {
    const extended = parseAppCatalogPage(
      page([app({ labels: ["new"], repository: { ...app().repository, branch: "main" } })]),
      resourceIdentifier,
    );
    expect(extended.skipped).toBe(0);
    expect(extended.apps[0]).not.toHaveProperty("labels");
    expect(extended.apps[0]!.repository).toEqual(app().repository);
    // URLs are stored as parsed.
    expect(
      parseAppCatalogPage(page([app({ url: "https://Expenses.Example.com" })]), resourceIdentifier)
        .apps[0]!.url,
    ).toBe("https://expenses.example.com/");
    expect(
      parseAppCatalogPage(
        page([app({ owner: null, repository: null, url: null, scopes: [] })]),
        resourceIdentifier,
      ).skipped,
    ).toBe(0);
    const { repository: _, ...withoutRepository } = app();
    const { url: __, ...withoutUrl } = app();
    for (const broken of [
      withoutRepository,
      withoutUrl,
      app({ id: "has space" }),
      app({ name: "" }),
      app({ name: "x".repeat(121) }),
      app({ name: "line\u2028break" }),
      app({ description: "" }),
      app({ description: "x".repeat(1_001) }),
      app({ owner: "" }),
      app({ owner: "\ud800" }),
      app({ scopes: [intranetScope, intranetScope] }),
      app({ scopes: ["Everyone"] }),
      app({ repository: { name: "a/b" } }),
      app({ repository: { name: "", url: "https://git.example.com/a/b" } }),
      app({ repository: { name: "a/b", url: "http://git.example.com/a/b" } }),
      app({ url: "data:text/html,hi" }),
      app({ url: "https://user@expenses.example.com" }),
      app({ url: "not a url" }),
      app({ revision: 0 }),
      app({ expiresAt: "soon" }),
      "not an app",
    ])
      expect(
        parseAppCatalogPage(page([app({ id: "app_ok" }), broken]), resourceIdentifier),
      ).toMatchObject({ skipped: 1, apps: [{ id: "app_ok" }] });
    for (const broken of [
      { ...page([]), schemaVersion: 2 },
      { ...page([]), extra: true },
      { ...page([]), apps: "none" },
      { ...page([]), apps: Array.from({ length: 501 }, () => app()) },
      { schemaVersion: 1, resource: resourceIdentifier, agents: [] },
      [],
    ])
      expect(() => parseAppCatalogPage(broken, resourceIdentifier)).toThrow();
  });

  it("renders a link only for an https URL", () => {
    expect(httpsHref("https://expenses.example.com/a?b=1")).toBe(
      "https://expenses.example.com/a?b=1",
    );
    for (const value of [
      null,
      undefined,
      "",
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,hi",
      "http://expenses.example.com",
      "https://user:secret@expenses.example.com",
      "//expenses.example.com",
      "not a url",
    ])
      expect(httpsHref(value)).toBeNull();
  });
});
