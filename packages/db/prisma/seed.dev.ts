import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { DEVELOPMENT_SKILL_SCOPE_KEYS, seedDevelopmentSkills } from "./seed.dev-skills.js";
import { seedDevelopmentSkillRetrievals, seedDevelopmentUsers } from "./seed.dev-users.js";

const db = new PrismaClient();
const actor = "development-seed";

try {
  const resourceDefinitions = [
    {
      key: "contracts",
      name: "Contract Service",
      scopes: [
        ["contracts:read", "Read contracts and obligations."],
        ["contracts:draft", "Draft and revise contracts."],
        ["contracts:approve", "Approve contract changes."],
      ],
    },
    {
      key: "licenses",
      name: "License Server",
      scopes: [
        ["licenses:read", "Read software license inventory."],
        ["licenses:manage", "Manage software licenses and renewals."],
        ["licenses:audit", "Audit software license usage."],
      ],
    },
    {
      key: "expenses",
      name: "Expense Service",
      scopes: [
        ["expenses:read", "Read expenses."],
        ["expenses:create", "Create expenses."],
        ["expenses:write", "Modify expenses."],
        ["expenses:delete", "Delete expenses."],
        ["expenses:submit", "Submit expenses."],
        ["expenses:approve", "Approve expenses."],
      ],
    },
    {
      key: "people",
      name: "People Directory",
      scopes: [
        ["people:read", "Read people and team information."],
        ["people:manage", "Manage people and employment records."],
        ["people:report", "Create workforce reports."],
      ],
    },
    {
      key: "crm",
      name: "Customer CRM",
      scopes: [
        ["crm:read", "Read customer and opportunity records."],
        ["crm:write", "Create and update customer records."],
        ["crm:export", "Export customer and campaign data."],
      ],
    },
    {
      key: "projects",
      name: "Project Hub",
      scopes: [
        ["projects:read", "Read projects and delivery status."],
        ["projects:plan", "Create and update project plans."],
        ["projects:manage", "Manage project execution."],
      ],
    },
    {
      key: "knowledge",
      name: "Knowledge Base",
      scopes: [
        ["knowledge:read", "Read internal knowledge."],
        ["knowledge:write", "Create and update knowledge content."],
        ["knowledge:publish", "Publish knowledge content."],
      ],
    },
  ] as const;

  if (resourceDefinitions.length !== 7) {
    throw new Error(`Expected 7 development resources, found ${resourceDefinitions.length}.`);
  }
  const seededScopeKeys = new Set<string>(
    resourceDefinitions.flatMap(({ scopes }) => scopes.map(([key]) => key)),
  );
  const missingSkillScopes = DEVELOPMENT_SKILL_SCOPE_KEYS.filter(
    (scope) => !seededScopeKeys.has(scope),
  );
  if (missingSkillScopes.length) {
    throw new Error(
      `Development skills reference unseeded scopes: ${missingSkillScopes.join(", ")}`,
    );
  }

  const resourceKeys = resourceDefinitions.map(({ key }) => key);
  await db.downstreamResource.deleteMany({
    where: { createdBy: actor, key: { notIn: resourceKeys } },
  });

  const resources = new Map<string, { id: string; version: number }>();
  for (const definition of resourceDefinitions) {
    for (const [key, description] of definition.scopes) {
      await db.scope.upsert({
        where: { key },
        create: {
          id: `scope-${key.replaceAll(":", "-")}`,
          key,
          description,
          createdBy: actor,
          updatedBy: actor,
        },
        update: { description, updatedBy: actor },
      });
    }

    const origin = `https://${definition.key}.seibert.localdev`;
    const resourceIdentifier = `${origin}/api`;
    const skillDiscoveryEnabled = definition.key === "contracts" || definition.key === "expenses";
    const resource = await db.downstreamResource.upsert({
      where: { key: definition.key },
      create: {
        id: `downstream-resource-${definition.key}`,
        key: definition.key,
        name: definition.name,
        resourceIdentifier,
        authorizationServer: origin,
        downstreamClientId: `weldall-cli-at-${definition.key}`,
        enabled: true,
        skillDiscoveryEnabled,
        createdBy: actor,
        updatedBy: actor,
      },
      update: {
        name: definition.name,
        resourceIdentifier,
        authorizationServer: origin,
        downstreamClientId: `weldall-cli-at-${definition.key}`,
        enabled: true,
        skillDiscoveryEnabled,
        updatedBy: actor,
      },
    });
    await db.resourceRequestPrefix.upsert({
      where: { urlPrefix: resourceIdentifier },
      create: {
        id: `resource-prefix-${definition.key}-api`,
        resourceId: resource.id,
        urlPrefix: resourceIdentifier,
        createdBy: actor,
      },
      update: { resourceId: resource.id },
    });
    const scopes = await db.scope.findMany({
      where: { key: { in: definition.scopes.map(([key]) => key) } },
      select: { id: true },
    });
    await db.resourceScope.deleteMany({
      where: { resourceId: resource.id, scopeId: { notIn: scopes.map(({ id }) => id) } },
    });
    for (const scope of scopes) {
      await db.resourceScope.upsert({
        where: { resourceId_scopeId: { resourceId: resource.id, scopeId: scope.id } },
        create: { resourceId: resource.id, scopeId: scope.id },
        update: {},
      });
    }
    resources.set(definition.key, resource);
  }

  await seedDevelopmentSkills(db, actor);
  const contracts = resources.get("contracts");
  if (!contracts) throw new Error("Development contract resource was not seeded.");
  const expenses = resources.get("expenses");
  if (!expenses) throw new Error("Development expense resource was not seeded.");
  await seedDevelopmentResourceSkill(contracts, {
    resourceKey: "contracts",
    localId: "contract-review",
    title: "Review a contract",
    content:
      "# Review a contract\n\nReview the contract terms, identify material risks, and summarize required follow-up.",
    requiredScopes: ["contracts:read"],
    tags: ["contracts", "review"],
  });
  await seedDevelopmentResourceSkill(expenses, {
    resourceKey: "expenses",
    localId: "review",
    title: "Review expenses",
    content:
      "# Review expenses\n\nUse `weldall request --scope expenses:read https://expenses.seibert.localdev/api/expenses` to list expenses.",
    requiredScopes: ["expenses:read"],
    tags: ["expenses", "review"],
  });
  await seedDevelopmentUsers(db);
  await seedDevelopmentSkillRetrievals(db);

  const publicJwk = parseDevelopmentMachinePublicJwk(process.env.DEV_M2M_SIGNING_PUBLIC_JWK);
  const kid = parseDevelopmentMachineKid(process.env.DEV_M2M_SIGNING_KID);
  const thumbprint = createHash("sha256")
    .update(
      JSON.stringify({
        crv: publicJwk.crv,
        kty: publicJwk.kty,
        x: publicJwk.x,
        y: publicJwk.y,
      }),
    )
    .digest("base64url");
  const expensesReadScope = await db.scope.findUniqueOrThrow({
    where: { key: "expenses:read" },
    select: { id: true },
  });
  await db.$transaction(async (tx) => {
    const machine = await tx.machineClient.upsert({
      where: { clientId: "dev-expenses-reader" },
      create: {
        id: "machine-client-dev-expenses-reader",
        clientId: "dev-expenses-reader",
        name: "Development expenses reader",
        enabled: true,
        createdBy: actor,
        updatedBy: actor,
      },
      update: {
        name: "Development expenses reader",
        enabled: true,
        deactivatedAt: null,
        updatedBy: actor,
      },
    });
    await Promise.all([
      tx.machineClientKey.deleteMany({
        where: { machineClientId: machine.id, kid: { not: kid } },
      }),
      tx.machineAllowedResource.deleteMany({
        where: { machineClientId: machine.id, resourceId: { not: expenses.id } },
      }),
      tx.machineAllowedScope.deleteMany({
        where: { machineClientId: machine.id, scopeId: { not: expensesReadScope.id } },
      }),
    ]);
    await Promise.all([
      tx.machineClientKey.upsert({
        where: { machineClientId_kid: { machineClientId: machine.id, kid } },
        create: {
          id: "machine-key-dev-expenses-reader",
          machineClientId: machine.id,
          kid,
          publicJwk,
          thumbprint,
          createdBy: actor,
        },
        update: { publicJwk, thumbprint, revokedAt: null, revokedBy: null },
      }),
      tx.machineAllowedResource.upsert({
        where: {
          machineClientId_resourceId: {
            machineClientId: machine.id,
            resourceId: expenses.id,
          },
        },
        create: { machineClientId: machine.id, resourceId: expenses.id },
        update: {},
      }),
      tx.machineAllowedScope.upsert({
        where: {
          machineClientId_scopeId: {
            machineClientId: machine.id,
            scopeId: expensesReadScope.id,
          },
        },
        create: { machineClientId: machine.id, scopeId: expensesReadScope.id },
        update: {},
      }),
    ]);
  });
} finally {
  await db.$disconnect();
}

async function seedDevelopmentResourceSkill(
  resource: { id: string; version: number },
  skill: {
    resourceKey: string;
    localId: string;
    title: string;
    content: string;
    requiredScopes: string[];
    tags: string[];
  },
) {
  const validUntil = new Date("2100-01-01T00:00:00.000Z");
  const refreshedAt = new Date();
  const catalog = await db.discoveredSkillCatalog.upsert({
    where: { resourceId: resource.id },
    create: {
      id: `development-${skill.resourceKey}-skill-catalog`,
      resourceId: resource.id,
      sourceResourceVersion: resource.version,
      schemaVersion: 1,
      lastAttemptAt: refreshedAt,
      lastSuccessfulRefreshAt: refreshedAt,
      nextRefreshAt: validUntil,
      staleAfter: validUntil,
    },
    update: {
      sourceResourceVersion: resource.version,
      schemaVersion: 1,
      lastAttemptAt: refreshedAt,
      lastSuccessfulRefreshAt: refreshedAt,
      nextRefreshAt: validUntil,
      staleAfter: validUntil,
      retryCount: 0,
      lastFailureCategory: null,
      lastFailureAt: null,
      refreshLeaseId: null,
      refreshLeaseUntil: null,
    },
  });

  const canonicalId = `${skill.resourceKey}.${skill.localId}`;
  await db.discoveredSkill.upsert({
    where: { canonicalId },
    create: {
      id: `development-discovered-skill-${skill.resourceKey}-${skill.localId}`,
      catalogId: catalog.id,
      localId: skill.localId,
      canonicalId,
      title: skill.title,
      content: skill.content,
      requiredScopes: skill.requiredScopes,
      visibility: "DEFAULT",
      meta: { tags: skill.tags },
      lastUpdatedAt: "development-seed",
    },
    update: {
      catalogId: catalog.id,
      localId: skill.localId,
      title: skill.title,
      content: skill.content,
      requiredScopes: skill.requiredScopes,
      visibility: "DEFAULT",
      meta: { tags: skill.tags },
      lastUpdatedAt: "development-seed",
    },
  });
}

function parseDevelopmentMachinePublicJwk(value: string | undefined): Prisma.InputJsonObject {
  if (!value) {
    throw new Error(
      "DEV_M2M_SIGNING_PUBLIC_JWK is required for development seeds. Generate .env with pnpm secrets:generate.",
    );
  }
  let jwk: unknown;
  try {
    jwk = JSON.parse(value);
  } catch {
    throw new Error("DEV_M2M_SIGNING_PUBLIC_JWK must be valid JSON.");
  }
  if (
    !jwk ||
    typeof jwk !== "object" ||
    Array.isArray(jwk) ||
    !("kty" in jwk) ||
    jwk.kty !== "EC" ||
    !("crv" in jwk) ||
    jwk.crv !== "P-256" ||
    !("x" in jwk) ||
    typeof jwk.x !== "string" ||
    !("y" in jwk) ||
    typeof jwk.y !== "string" ||
    "d" in jwk
  ) {
    throw new Error("DEV_M2M_SIGNING_PUBLIC_JWK must be a public ES256 P-256 JWK.");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function parseDevelopmentMachineKid(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error("DEV_M2M_SIGNING_KID must be a valid machine key ID.");
  }
  return value;
}
