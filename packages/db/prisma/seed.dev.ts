import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

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
