import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const actor = "development-seed";

try {
  const scopeDefinitions = [
    ["scope-expenses-read", "expenses:read", "Read expenses."],
    ["scope-expenses-create", "expenses:create", "Create expenses."],
    ["scope-expenses-delete", "expenses:delete", "Delete expenses."],
    ["scope-expenses-write", "expenses:write", "Modify expenses."],
  ] as const;
  for (const [id, key, description] of scopeDefinitions) {
    await db.scope.upsert({
      where: { key },
      create: { id, key, description, createdBy: actor, updatedBy: actor },
      update: { description, updatedBy: actor },
    });
  }

  const expenses = await db.downstreamResource.upsert({
    where: { key: "expenses" },
    create: {
      id: "downstream-resource-expenses",
      key: "expenses",
      name: "Expenses",
      resourceIdentifier: "https://expenses.seibert.localdev/api",
      authorizationServer: "https://expenses.seibert.localdev",
      downstreamClientId: "weldall-cli-at-expenses",
      enabled: true,
      skillDiscoveryEnabled: true,
      createdBy: actor,
      updatedBy: actor,
    },
    update: { enabled: true, skillDiscoveryEnabled: true, updatedBy: actor },
  });
  await db.resourceRequestPrefix.upsert({
    where: { urlPrefix: "https://expenses.seibert.localdev/api" },
    create: {
      id: "resource-prefix-expenses-api",
      resourceId: expenses.id,
      urlPrefix: "https://expenses.seibert.localdev/api",
      createdBy: actor,
    },
    update: { resourceId: expenses.id },
  });
  const expenseScopes = await db.scope.findMany({
    where: { key: { startsWith: "expenses:" } },
    select: { id: true },
  });
  for (const scope of expenseScopes) {
    await db.resourceScope.upsert({
      where: {
        resourceId_scopeId: { resourceId: expenses.id, scopeId: scope.id },
      },
      create: { resourceId: expenses.id, scopeId: scope.id },
      update: {},
    });
  }
  await db.discoveredSkillCatalog.upsert({
    where: { resourceId: expenses.id },
    create: { resourceId: expenses.id, nextRefreshAt: new Date() },
    update: { nextRefreshAt: new Date() },
  });

  const developmentResource = await db.downstreamResource.upsert({
    where: { key: "development-catalog" },
    create: {
      id: "downstream-resource-development-catalog",
      key: "development-catalog",
      name: "Development catalog diagnostics",
      resourceIdentifier: "https://development-skills.seibert.localdev/api",
      authorizationServer: "https://development-skills.seibert.localdev",
      downstreamClientId: "weldall-cli-at-development-skills",
      enabled: true,
      skillDiscoveryEnabled: true,
      createdBy: actor,
      updatedBy: actor,
    },
    update: { enabled: true, skillDiscoveryEnabled: true, updatedBy: actor },
  });
  await db.resourceRequestPrefix.upsert({
    where: { urlPrefix: "https://development-skills.seibert.localdev/api" },
    create: {
      id: "resource-prefix-development-skills-api",
      resourceId: developmentResource.id,
      urlPrefix: "https://development-skills.seibert.localdev/api",
      createdBy: actor,
    },
    update: { resourceId: developmentResource.id },
  });
  const now = new Date();
  const catalog = await db.discoveredSkillCatalog.upsert({
    where: { resourceId: developmentResource.id },
    create: {
      resourceId: developmentResource.id,
      sourceResourceVersion: developmentResource.version,
      schemaVersion: 1,
      lastAttemptAt: now,
      lastSuccessfulRefreshAt: now,
      nextRefreshAt: new Date(now.getTime() + 10 * 60 * 1_000),
      staleAfter: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    },
    update: {
      sourceResourceVersion: developmentResource.version,
      schemaVersion: 1,
      lastSuccessfulRefreshAt: now,
      nextRefreshAt: new Date(now.getTime() + 10 * 60 * 1_000),
      staleAfter: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    },
  });
  await db.discoveredSkill.upsert({
    where: { canonicalId: "development-catalog.unknown-scope" },
    create: {
      catalogId: catalog.id,
      localId: "unknown-scope",
      canonicalId: "development-catalog.unknown-scope",
      title: "Unknown scope diagnostics",
      content:
        "# Unknown scope diagnostics\n\nThis development-only skill exercises admin warnings.",
      requiredScopes: ["development:unknown"],
      visibility: "DEFAULT",
    },
    update: {
      catalogId: catalog.id,
      requiredScopes: ["development:unknown"],
      visibility: "DEFAULT",
    },
  });
} finally {
  await db.$disconnect();
}
