import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { getVisibleSkill, listVisibleSkills } from "../src/server/skills/service";

const approved =
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const key = `skill-mcp-${randomBytes(6).toString("hex")}`;
const email = `${key}@example.com`;
const scopeKey = `${key}:use`;
const manualSlug = `${key}.manual`;
const publishedSlug = `${key}.published`;
const dependencies = [{ connectorKey: key, tools: ["search"], includeResources: false }];
const provenance = { createdBy: key, updatedBy: key };
let scopeId: string;
let publishedId: string;

async function expectVisibility(visible: boolean, caller = email) {
  const catalog = await listVisibleSkills(caller);
  for (const slug of [manualSlug, publishedSlug]) {
    expect(
      catalog.items.some((skill) => skill.slug === slug),
      `catalog: ${slug}`,
    ).toBe(visible);
    const detail = await getVisibleSkill(caller, slug);
    if (visible) expect(detail).toMatchObject({ slug, mcpDependencies: dependencies });
    else expect(detail, `direct retrieval: ${slug}`).toBeNull();
  }
}

async function setDependencies(value: typeof dependencies) {
  await db.skill.update({ where: { slug: manualSlug }, data: { mcpDependencies: value } });
  await db.discoveredSkill.update({
    where: { id: publishedId },
    data: { mcpDependencies: value },
  });
}

describe.skipIf(!approved)("MCP-dependent skill visibility", () => {
  beforeAll(async () => {
    const scope = await db.scope.create({
      data: { key: scopeKey, description: "MCP skill access", ...provenance },
    });
    scopeId = scope.id;
    await db.emailScopeAssignment.create({
      data: {
        normalizedEmail: email,
        ...provenance,
        grants: { create: { scopeId, createdBy: key } },
      },
    });
    const resource = await db.downstreamResource.create({
      data: {
        key,
        name: key,
        resourceIdentifier: `https://${key}.example/api`,
        authorizationServer: `https://${key}.example`,
        downstreamClientId: key,
        enabled: true,
        skillDiscoveryEnabled: true,
        ...provenance,
        discoveredCatalog: {
          create: {
            sourceResourceVersion: 1,
            lastSuccessfulRefreshAt: new Date(),
            staleAfter: new Date(Date.now() + 86_400_000),
            skills: {
              create: {
                localId: "published",
                canonicalId: publishedSlug,
                title: "Published MCP skill",
                content: "# Published MCP skill",
                visibility: "DEFAULT",
                requiredScopes: [],
                mcpDependencies: dependencies,
              },
            },
          },
        },
      },
      include: { discoveredCatalog: { include: { skills: true } } },
    });
    publishedId = resource.discoveredCatalog!.skills[0]!.id;
  });

  beforeEach(async () => {
    const connector = {
      name: key,
      enabled: true,
      providerType: "atlassian-mcp",
      providerConfig: {},
      envelopeProvider: "LOCAL_ENV" as const,
    };
    await db.connector.upsert({
      where: { key },
      create: { key, ...connector, ...provenance, requiredScopes: { create: { scopeId } } },
      update: connector,
    });
    await db.skill.deleteMany({ where: { createdBy: key } });
    await db.skill.create({
      data: {
        slug: manualSlug,
        title: "Manual MCP skill",
        content: "# Manual MCP skill",
        visibility: "DEFAULT",
        mcpDependencies: dependencies,
        ...provenance,
      },
    });
    await setDependencies(dependencies);
  });

  afterAll(async () => {
    await db.skill.deleteMany({ where: { createdBy: key } });
    await db.downstreamResource.deleteMany({ where: { key } });
    await db.connector.deleteMany({ where: { key } });
    await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: email } });
    await db.scope.deleteMany({ where: { key: scopeKey } });
  });

  it("shows both sources without any personal connection", async () => {
    expect(await db.connection.count({ where: { connector: { key } } })).toBe(0);
    await expectVisibility(true);
  });

  it("hides both sources without connector permission, independently of skill scopes", async () => {
    await expectVisibility(false, `${key}-unprivileged@example.com`);
    await expectVisibility(true);
  });

  it.each([
    ["disabled", { enabled: false }],
    ["HTTP-only", { providerType: "atlassian" }],
    ["unknown provider", { providerType: "unknown-provider" }],
  ] as const)("hides skills with a %s connector", async (_label, data) => {
    await db.connector.update({ where: { key }, data });
    await expectVisibility(false);
  });

  it("hides missing connectors and resolves them later without republishing the skills", async () => {
    const connector = await db.connector.findUniqueOrThrow({ where: { key } });
    await db.connector.delete({ where: { key } });
    await expectVisibility(false);
    await db.connector.create({
      data: { ...connector, providerConfig: {}, requiredScopes: { create: { scopeId } } },
    });
    await expectVisibility(true);
  });

  it("requires every dependency, not merely one accessible connector", async () => {
    await setDependencies([
      ...dependencies,
      { connectorKey: `${key}-missing`, tools: ["search"], includeResources: false },
    ]);
    await expectVisibility(false);
  });

  it("preserves skills without MCP dependencies even for users without connector access", async () => {
    await setDependencies([]);
    const caller = `${key}-unprivileged@example.com`;
    const catalog = await listVisibleSkills(caller);
    for (const slug of [manualSlug, publishedSlug]) {
      expect(catalog.items.some((skill) => skill.slug === slug)).toBe(true);
      await expect(getVisibleSkill(caller, slug)).resolves.toMatchObject({ mcpDependencies: [] });
    }
  });

  it("does not fall back to a published skill shadowed by an inaccessible manual skill", async () => {
    await db.skill.create({
      data: {
        slug: publishedSlug,
        title: "Manual override",
        content: "# Manual override",
        mcpDependencies: [
          { connectorKey: `${key}-missing`, tools: ["search"], includeResources: false },
        ],
        ...provenance,
      },
    });
    const catalog = await listVisibleSkills(email);
    expect(catalog.items.some((skill) => skill.slug === publishedSlug)).toBe(false);
    await expect(getVisibleSkill(email, publishedSlug)).resolves.toBeNull();
  });
});
