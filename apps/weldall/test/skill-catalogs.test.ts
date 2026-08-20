import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import { listSkills, listSkillSourceOptions } from "../src/server/admin/service.js";
import { logger } from "../src/server/observability/logger.js";
import { refreshDueCatalogs, refreshResourceCatalog } from "../src/server/skills/catalogs.js";
import {
  getVisibleSkill,
  listVisibleSkills,
  SkillTemporarilyUnavailableError,
} from "../src/server/skills/service.js";

const id = randomUUID().replaceAll("-", "");
const key = `catalogtest-${id}`;
const origin = `https://${key}.example`;
const resourceIdentifier = `${origin}/api`;
const metadataUrl = `${origin}/.well-known/oauth-protected-resource/api`;
const catalogEndpoint = `${origin}/.well-known/weldall-skills`;

const fetchCatalog = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === metadataUrl) {
    return Response.json({
      resource: resourceIdentifier,
      authorization_servers: [origin],
      weldall_skills_endpoint: catalogEndpoint,
    });
  }
  if (url === catalogEndpoint) {
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
    return Response.json({
      schemaVersion: 1,
      resource: resourceIdentifier,
      skills: [
        {
          id: "review",
          title: "Review catalog test data",
          requiredScopes: ["expenses:read"],
          visibility: "DEFAULT",
          content: "# Review catalog test data",
          meta: { tags: ["catalog", ""], owner: "catalog-owner" },
          lastUpdatedAt: "catalog-version-7",
        },
        {
          id: "system-scope",
          title: "System scope test",
          requiredScopes: ["weldall:administer"],
          visibility: "DEFAULT",
          content: "# System scope test",
        },
        {
          id: "unknown-scope",
          title: "Unknown scope test",
          requiredScopes: ["catalogtest:unknown"],
          visibility: "DEFAULT",
          content: "# Unknown scope test",
        },
      ],
    });
  }
  return new Response(null, { status: 404 });
});

const adminEmail = `${id}-admin@example.com`;
const priorSigningEnv = {
  kid: process.env.WELDALL_SIGNING_KID,
  privateJwk: process.env.WELDALL_SIGNING_PRIVATE_JWK,
  publicJwk: process.env.WELDALL_SIGNING_PUBLIC_JWK,
};
const signingKey = await generateEs256KeyPair();
process.env.WELDALL_SIGNING_KID = `catalog-test-${id}`;
process.env.WELDALL_SIGNING_PRIVATE_JWK = JSON.stringify(signingKey.privateJwk);
process.env.WELDALL_SIGNING_PUBLIC_JWK = JSON.stringify(signingKey.publicJwk);
const resource = await db.downstreamResource.create({
  data: {
    key,
    name: "Catalog refresh test",
    resourceIdentifier,
    authorizationServer: origin,
    downstreamClientId: `client-${key}`,
    enabled: true,
    skillDiscoveryEnabled: true,
    createdBy: "skill-catalog-test",
    updatedBy: "skill-catalog-test",
    discoveredCatalog: {
      create: { nextRefreshAt: new Date("2000-01-01T00:00:00.000Z") },
    },
  },
});
const adminScope = await db.scope.findUniqueOrThrow({
  where: { key: "weldall:administer" },
});
await db.emailScopeAssignment.create({
  data: {
    normalizedEmail: adminEmail,
    createdBy: "skill-catalog-test",
    updatedBy: "skill-catalog-test",
    grants: {
      create: {
        id: randomUUID(),
        scopeId: adminScope.id,
        createdBy: "skill-catalog-test",
      },
    },
  },
});

afterAll(async () => {
  await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: adminEmail } });
  await db.downstreamResource.deleteMany({ where: { id: resource.id } });
  for (const [name, value] of [
    ["WELDALL_SIGNING_KID", priorSigningEnv.kid],
    ["WELDALL_SIGNING_PRIVATE_JWK", priorSigningEnv.privateJwk],
    ["WELDALL_SIGNING_PUBLIC_JWK", priorSigningEnv.publicJwk],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("persisted skill catalog refresh", () => {
  it("atomically persists catalogs and exposes unknown scopes only to administrators", async () => {
    await refreshDueCatalogs({
      fetcher: fetchCatalog as typeof fetch,
      limit: 1,
    });
    const catalog = await db.discoveredSkillCatalog.findUniqueOrThrow({
      where: { resourceId: resource.id },
      include: { skills: { orderBy: { localId: "asc" } } },
    });
    expect(catalog).toMatchObject({
      sourceResourceVersion: resource.version,
      schemaVersion: 1,
      retryCount: 0,
      lastFailureCategory: null,
    });
    expect(catalog.skills.map((skill) => skill.canonicalId)).toEqual([
      `${key}.review`,
      `${key}.system-scope`,
      `${key}.unknown-scope`,
    ]);

    const admin = await listSkills({ page: 1, pageSize: 20, q: key });
    expect(admin.items.find((skill) => skill.slug.endsWith("unknown-scope"))).toMatchObject({
      readOnly: true,
      scopeWarnings: ["Unknown scope: catalogtest:unknown"],
    });
    expect(admin.items.find((skill) => skill.slug.endsWith("system-scope"))).toMatchObject({
      requiredScopes: ["weldall:administer"],
      scopeWarnings: [],
    });
    await expect(listSkills({ page: 1, pageSize: 20, source: resource.id })).resolves.toMatchObject(
      { total: 3 },
    );
    await expect(
      listSkills({ page: 1, pageSize: 20, q: key, source: "manual" }),
    ).resolves.toMatchObject({ total: 0 });
    await expect(listSkillSourceOptions()).resolves.toContainEqual({
      id: resource.id,
      name: resource.name,
    });
    const visible = await listVisibleSkills(`${id}@example.com`);
    expect(visible.items.find((skill) => skill.slug === `${key}.review`)).toMatchObject({
      preview: "Review catalog test data",
      meta: { tags: ["catalog", ""], owner: "catalog-owner" },
      lastUpdatedAt: "catalog-version-7",
    });
    expect(visible.items.find((skill) => skill.slug === `${key}.system-scope`)).toMatchObject({
      available: false,
      missingScopes: ["weldall:administer"],
    });
    expect(visible.items.some((skill) => skill.slug === `${key}.unknown-scope`)).toBe(false);
    await expect(getVisibleSkill(adminEmail, `${key}.review`)).resolves.toMatchObject({
      meta: { tags: ["catalog", ""], owner: "catalog-owner" },
      lastUpdatedAt: "catalog-version-7",
      document: expect.stringContaining('lastUpdatedAt: "catalog-version-7"'),
    });
    await expect(getVisibleSkill(adminEmail, `${key}.system-scope`)).resolves.toMatchObject({
      requiredScopes: ["weldall:administer"],
      available: true,
      missingScopes: [],
    });
    await expect(getVisibleSkill(adminEmail, `${key}.unknown-scope`)).resolves.toBeNull();
  });

  it("immediately refreshes one resource even when its catalog is not due", async () => {
    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: { nextRefreshAt: new Date("2100-01-01T00:00:00.000Z") },
    });

    await expect(
      refreshResourceCatalog(resource.id, {
        fetcher: fetchCatalog as typeof fetch,
      }),
    ).resolves.toBe("succeeded");

    const catalog = await db.discoveredSkillCatalog.findUniqueOrThrow({
      where: { resourceId: resource.id },
    });
    expect(catalog.lastFailureCategory).toBeNull();
    expect(catalog.lastSuccessfulRefreshAt).not.toBeNull();
    expect(catalog.nextRefreshAt.getTime()).toBeLessThan(
      new Date("2100-01-01T00:00:00.000Z").getTime(),
    );
  });

  it("does not overlap an in-progress manual refresh", async () => {
    fetchCatalog.mockClear();
    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: {
        refreshLeaseId: "active-manual-refresh",
        refreshLeaseUntil: new Date("2100-01-01T00:00:00.000Z"),
      },
    });

    await expect(
      refreshResourceCatalog(resource.id, {
        fetcher: fetchCatalog as typeof fetch,
      }),
    ).resolves.toBe("already_running");
    expect(fetchCatalog).not.toHaveBeenCalled();

    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: { refreshLeaseId: null, refreshLeaseUntil: null },
    });
  });

  it("returns a failed manual refresh without replacing the last valid rows", async () => {
    const warnings: Record<string, any>[] = [];
    const detach = logger.attachTransport((record) => {
      if (record._logMeta.logLevelName === "WARN") warnings.push(record);
    });
    try {
      await expect(
        refreshResourceCatalog(resource.id, {
          fetcher: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
        }),
      ).resolves.toBe("failed");
      const catalog = await db.discoveredSkillCatalog.findUniqueOrThrow({
        where: { resourceId: resource.id },
        include: { skills: true },
      });
      expect(catalog.lastFailureCategory).toBe("metadata_unavailable");
      expect(catalog.skills).toHaveLength(3);
      const nonAdminView = await listVisibleSkills(`${id}-non-admin@example.com`);
      expect(nonAdminView.warnings).toEqual([]);
      const adminView = await listVisibleSkills(adminEmail);
      expect(adminView.warnings).toContainEqual({
        source: key,
        code: "catalog_temporarily_unavailable",
      });
      expect(warnings).toContainEqual(
        expect.objectContaining({
          0: expect.objectContaining({
            event: "skill_catalog.refresh.failed",
            publisherId: resource.id,
            failureCategory: "metadata_unavailable",
          }),
        }),
      );
    } finally {
      detach();
    }
  });

  it("does not expose expired catalog failures to non-administrators", async () => {
    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: { staleAfter: new Date("2000-01-01T00:00:00.000Z") },
    });

    await expect(
      getVisibleSkill(`${id}-non-admin@example.com`, `${key}.review`),
    ).resolves.toBeNull();
    await expect(getVisibleSkill(adminEmail, `${key}.review`)).rejects.toBeInstanceOf(
      SkillTemporarilyUnavailableError,
    );
  });

  it("retains persisted rows but marks them disabled for administrators", async () => {
    await db.downstreamResource.update({
      where: { id: resource.id },
      data: { skillDiscoveryEnabled: false, version: { increment: 1 } },
    });
    const admin = await listSkills({ page: 1, pageSize: 20, q: key });
    expect(admin.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ readOnly: true, disabled: true })]),
    );
    const visible = await listVisibleSkills(`${id}@example.com`);
    expect(visible.items.some((skill) => skill.slug.startsWith(`${key}.`))).toBe(false);

    fetchCatalog.mockClear();
    await expect(
      refreshResourceCatalog(resource.id, {
        fetcher: fetchCatalog as typeof fetch,
      }),
    ).resolves.toBe("unavailable");
    expect(fetchCatalog).not.toHaveBeenCalled();
  });
});
