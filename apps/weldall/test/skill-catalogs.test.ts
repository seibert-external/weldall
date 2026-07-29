import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { listSkills } from "../src/server/admin/service.js";
import { refreshDueCatalogs } from "../src/server/skills/catalogs.js";
import { listVisibleSkills } from "../src/server/skills/service.js";

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

afterAll(async () => {
  await db.downstreamResource.deleteMany({ where: { id: resource.id } });
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
      `${key}.unknown-scope`,
    ]);

    const admin = await listSkills({ page: 1, pageSize: 20, q: key });
    expect(admin.items.find((skill) => skill.slug.endsWith("unknown-scope"))).toMatchObject({
      readOnly: true,
      scopeWarnings: ["Unknown scope: catalogtest:unknown"],
    });
    const visible = await listVisibleSkills(`${id}@example.com`);
    expect(visible.items.some((skill) => skill.slug === `${key}.review`)).toBe(true);
    expect(visible.items.some((skill) => skill.slug === `${key}.unknown-scope`)).toBe(false);
  });

  it("logs and persists failed refreshes without replacing the last valid rows", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await db.discoveredSkillCatalog.update({
      where: { resourceId: resource.id },
      data: { nextRefreshAt: new Date("2000-01-01T00:00:00.000Z") },
    });
    await refreshDueCatalogs({
      fetcher: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
      limit: 1,
    });
    const catalog = await db.discoveredSkillCatalog.findUniqueOrThrow({
      where: { resourceId: resource.id },
      include: { skills: true },
    });
    expect(catalog.lastFailureCategory).toBe("metadata_unavailable");
    expect(catalog.skills).toHaveLength(2);
    expect(warning).toHaveBeenCalledWith(
      "Skill catalog refresh failed",
      expect.objectContaining({
        publisherId: resource.id,
        failureCategory: "metadata_unavailable",
      }),
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
  });
});
