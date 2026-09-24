import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { DEVELOPMENT_SKILL_SCOPE_KEYS, seedDevelopmentSkills } from "./seed.dev-skills.js";
import {
  DEVELOPMENT_USERS,
  seedDevelopmentSkillRetrievals,
  seedDevelopmentUsers,
} from "./seed.dev-users.js";

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
  await seedDevelopmentManagedConnectors();
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

async function seedDevelopmentManagedConnectors() {
  const sourceMaterial = new Map([
    [
      "DEV_MANAGED_CONNECTOR_KEY_PRIMARY",
      developmentManagedKey("DEV_MANAGED_CONNECTOR_KEY_PRIMARY"),
    ],
    [
      "DEV_MANAGED_CONNECTOR_KEY_ROTATION",
      developmentManagedKey("DEV_MANAGED_CONNECTOR_KEY_ROTATION"),
    ],
    [
      "DEV_MANAGED_CONNECTOR_KEY_ARCHIVE",
      developmentManagedKey("DEV_MANAGED_CONNECTOR_KEY_ARCHIVE"),
    ],
  ]);
  const keyDefinitions = [
    {
      id: "dev-encryption-key-primary",
      key: "managed-primary",
      name: "Managed connector primary key",
      activeVersion: "2026",
      versions: [
        ["2025", "DEV_MANAGED_CONNECTOR_KEY_ROTATION"],
        ["2026", "DEV_MANAGED_CONNECTOR_KEY_PRIMARY"],
      ],
    },
    {
      id: "dev-encryption-key-archive",
      key: "managed-archive",
      name: "Archive and recovery key",
      activeVersion: "1",
      versions: [["1", "DEV_MANAGED_CONNECTOR_KEY_ARCHIVE"]],
    },
  ] as const;
  const encryptionKeys = new Map<string, { id: string; activeVersion: string }>();
  for (const definition of keyDefinitions) {
    const key = await db.encryptionKey.upsert({
      where: { key: definition.key },
      create: {
        id: definition.id,
        key: definition.key,
        name: definition.name,
        activeVersion: definition.activeVersion,
        createdBy: actor,
        updatedBy: actor,
      },
      update: {
        name: definition.name,
        activeVersion: definition.activeVersion,
        updatedBy: actor,
      },
    });
    for (const [version, sourceName] of definition.versions) {
      const material = sourceMaterial.get(sourceName);
      if (!material) throw new Error(`Missing development connector source ${sourceName}.`);
      await db.encryptionKeyVersion.upsert({
        where: { keyId_version: { keyId: key.id, version } },
        create: {
          keyId: key.id,
          version,
          providerType: "local-env",
          providerConfig: { variable: sourceName },
          providerState: {
            fingerprint: createHash("sha256").update(material).digest("hex"),
          },
        },
        update: {
          providerType: "local-env",
          providerConfig: { variable: sourceName },
          providerState: {
            fingerprint: createHash("sha256").update(material).digest("hex"),
          },
        },
      });
    }
    encryptionKeys.set(definition.key, { id: key.id, activeVersion: definition.activeVersion });
  }

  const gmailRead = "https://www.googleapis.com/auth/gmail.readonly";
  const gmailSend = "https://www.googleapis.com/auth/gmail.send";
  const calendarRead = "https://www.googleapis.com/auth/calendar.readonly";
  const calendarEvents = "https://www.googleapis.com/auth/calendar.events";
  const connectorDefinitions = [
    {
      id: "dev-connector-workspace",
      key: "google-workspace",
      name: "Company Google Workspace",
      enabled: true,
      enabledApis: ["gmail", "calendar"],
      allowedScopes: [gmailRead, gmailSend, calendarRead, calendarEvents],
      defaultScopes: [gmailRead, calendarRead],
      clientId: "weldall-workspace-dev.apps.googleusercontent.com",
      encryptionKey: "managed-primary",
      secret: "development-workspace-client-secret",
    },
    {
      id: "dev-connector-mail",
      key: "google-mail",
      name: "Support mailbox connector",
      enabled: true,
      enabledApis: ["gmail"],
      allowedScopes: [gmailRead, gmailSend],
      defaultScopes: [gmailRead],
      clientId: "weldall-mail-dev.apps.googleusercontent.com",
      encryptionKey: "managed-primary",
      secret: "development-mail-client-secret",
    },
    {
      id: "dev-connector-sandbox",
      key: "google-sandbox",
      name: "Calendar sandbox",
      enabled: false,
      enabledApis: ["calendar"],
      allowedScopes: [calendarRead, calendarEvents],
      defaultScopes: [calendarRead],
      clientId: "weldall-sandbox-dev.apps.googleusercontent.com",
      encryptionKey: "managed-archive",
      secret: null,
    },
  ] as const;
  const connectors = new Map<string, { id: string; version: number; encryptionKeyId: string }>();
  for (const definition of connectorDefinitions) {
    const encryptionKey = encryptionKeys.get(definition.encryptionKey);
    if (!encryptionKey)
      throw new Error(`Development encryption key ${definition.encryptionKey} was not seeded.`);
    let connector = await db.connector.upsert({
      where: { key: definition.key },
      create: {
        id: definition.id,
        key: definition.key,
        name: definition.name,
        enabled: definition.enabled,
        enabledApis: [...definition.enabledApis],
        allowedScopes: [...definition.allowedScopes],
        defaultScopes: [...definition.defaultScopes],
        clientId: definition.clientId,
        encryptionKeyId: encryptionKey.id,
        createdBy: actor,
        updatedBy: actor,
      },
      update: {
        name: definition.name,
        enabled: definition.enabled,
        enabledApis: [...definition.enabledApis],
        allowedScopes: [...definition.allowedScopes],
        defaultScopes: [...definition.defaultScopes],
        clientId: definition.clientId,
        encryptionKeyId: encryptionKey.id,
        updatedBy: actor,
      },
    });
    if (definition.secret) {
      const secretId = `dev-encrypted-connector-${definition.key}`;
      await upsertDevelopmentEncryptedValue({
        id: secretId,
        keyId: encryptionKey.id,
        keyVersion: encryptionKey.activeVersion,
        material: sourceMaterial.get(
          keyDefinitions
            .find((candidate) => candidate.key === definition.encryptionKey)!
            .versions.find(([version]) => version === encryptionKey.activeVersion)![1],
        )!,
        context: `connector:${connector.id}:client-secret`,
        plaintext: definition.secret,
      });
      connector = await db.connector.update({
        where: { id: connector.id },
        data: { secretId },
      });
    } else if (connector.secretId) {
      await db.connector.update({ where: { id: connector.id }, data: { secretId: null } });
      await db.encryptedValue.deleteMany({ where: { id: connector.secretId } });
    }
    connectors.set(definition.key, connector);
  }

  const connectionDefinitions = [
    {
      id: "dev-connection-jane-workspace",
      ownerId: DEVELOPMENT_USERS[0]!.id,
      connector: "google-workspace",
      name: "jane-workspace",
      accountId: "google-jane-adams",
      accountName: "jane.adams@example.com",
      selectedScopes: ["openid", "email", gmailRead, calendarRead],
      grantedScopes: ["openid", "email", gmailRead, calendarRead],
      status: "READY" as const,
      requestCount: 184,
      lastUsedAt: new Date(Date.now() - 12 * 60 * 1000),
    },
    {
      id: "dev-connection-omar-support",
      ownerId: DEVELOPMENT_USERS[1]!.id,
      connector: "google-mail",
      name: "support-inbox",
      accountId: "google-omar-support",
      accountName: "support@example.com",
      selectedScopes: ["openid", "email", gmailRead, gmailSend],
      grantedScopes: ["openid", "email", gmailRead, gmailSend],
      status: "READY" as const,
      requestCount: 47,
      lastUsedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    },
    {
      id: "dev-connection-sofia-calendar",
      ownerId: DEVELOPMENT_USERS[2]!.id,
      connector: "google-workspace",
      name: "team-calendar",
      accountId: "google-sofia-calendar",
      accountName: "sofia.marchetti@example.com",
      selectedScopes: ["openid", "email", calendarRead, calendarEvents],
      grantedScopes: ["openid", "email", calendarRead],
      status: "RECONNECT_REQUIRED" as const,
      requestCount: 21,
      lastUsedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    },
    {
      id: "dev-connection-liam-revocation",
      ownerId: DEVELOPMENT_USERS[3]!.id,
      connector: "google-mail",
      name: "former-sales-inbox",
      accountId: "google-liam-sales",
      accountName: "sales@example.com",
      selectedScopes: ["openid", "email", gmailRead],
      grantedScopes: ["openid", "email", gmailRead],
      status: "REVOCATION_PENDING" as const,
      requestCount: 6,
      lastUsedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      revocationError: "Google revocation endpoint timed out during the last attempt.",
    },
    {
      id: "dev-connection-priya-disconnected",
      ownerId: DEVELOPMENT_USERS[4]!.id,
      connector: "google-workspace",
      name: "old-personal-calendar",
      accountId: "google-priya-old",
      accountName: "priya.raman@example.com",
      selectedScopes: ["openid", "email", calendarRead],
      grantedScopes: ["openid", "email", calendarRead],
      status: "DISCONNECTED" as const,
      requestCount: 92,
      lastUsedAt: new Date(Date.now() - 65 * 24 * 60 * 60 * 1000),
    },
  ];
  const seededConnectionIds = connectionDefinitions.map(({ id }) => id);
  await db.connectionAuthorization.deleteMany({
    where: { id: { startsWith: "dev-authorization-" } },
  });
  const staleConnections = await db.connection.findMany({
    where: { id: { startsWith: "dev-connection-", notIn: seededConnectionIds } },
    select: { id: true, credentialId: true },
  });
  await db.connection.deleteMany({ where: { id: { in: staleConnections.map(({ id }) => id) } } });
  await db.encryptedValue.deleteMany({
    where: {
      id: {
        in: staleConnections.flatMap(({ credentialId }) => (credentialId ? [credentialId] : [])),
      },
    },
  });

  for (const definition of connectionDefinitions) {
    const connector = connectors.get(definition.connector);
    if (!connector)
      throw new Error(`Development connector ${definition.connector} was not seeded.`);
    const keyDefinition = connectorDefinitions.find(({ key }) => key === definition.connector)!;
    const encryptionKey = encryptionKeys.get(keyDefinition.encryptionKey)!;
    const sourceName = keyDefinitions
      .find(({ key }) => key === keyDefinition.encryptionKey)!
      .versions.find(([version]) => version === encryptionKey.activeVersion)![1];
    const credentialId =
      definition.status === "DISCONNECTED" ? null : `dev-encrypted-connection-${definition.id}`;
    if (credentialId) {
      await upsertDevelopmentEncryptedValue({
        id: credentialId,
        keyId: encryptionKey.id,
        keyVersion: encryptionKey.activeVersion,
        material: sourceMaterial.get(sourceName)!,
        context: `connection:${definition.id}:credentials`,
        plaintext: JSON.stringify({
          accessToken: `development-access-${definition.id}`,
          refreshToken: `development-refresh-${definition.id}`,
          expiresAt: Date.now() + 60 * 60 * 1000,
          grantedScopes: definition.grantedScopes,
        }),
      });
    }
    await db.connection.upsert({
      where: { id: definition.id },
      create: {
        id: definition.id,
        ownerId: definition.ownerId,
        connectorId: connector.id,
        name: definition.name,
        accountId: definition.accountId,
        accountName: definition.accountName,
        selectedScopes: definition.selectedScopes,
        grantedScopes: definition.grantedScopes,
        status: definition.status,
        credentialId,
        requestCount: definition.requestCount,
        lastUsedAt: definition.lastUsedAt,
        revocationError: "revocationError" in definition ? definition.revocationError : null,
      },
      update: {
        ownerId: definition.ownerId,
        connectorId: connector.id,
        name: definition.name,
        accountId: definition.accountId,
        accountName: definition.accountName,
        selectedScopes: definition.selectedScopes,
        grantedScopes: definition.grantedScopes,
        status: definition.status,
        credentialId,
        requestCount: definition.requestCount,
        lastUsedAt: definition.lastUsedAt,
        revocationError: "revocationError" in definition ? definition.revocationError : null,
      },
    });
  }

  const now = Date.now();
  const authorizationDefinitions = [
    {
      id: "dev-authorization-active",
      ownerId: DEVELOPMENT_USERS[5]!.id,
      connector: "google-workspace",
      name: "noah-workspace",
      status: "SETUP",
      expiresAt: new Date(now + 7 * 60 * 1000),
    },
    {
      id: "dev-authorization-failed",
      ownerId: DEVELOPMENT_USERS[6]!.id,
      connector: "google-mail",
      name: "support-backup",
      status: "FAILED",
      expiresAt: new Date(now - 45 * 60 * 1000),
    },
    {
      id: "dev-authorization-expired",
      ownerId: DEVELOPMENT_USERS[7]!.id,
      connector: "google-workspace",
      name: "kenji-calendar",
      status: "EXPIRED",
      expiresAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    },
  ];
  for (const definition of authorizationDefinitions) {
    const connector = connectors.get(definition.connector)!;
    await db.connectionAuthorization.create({
      data: {
        id: definition.id,
        ownerId: definition.ownerId,
        connectorId: connector.id,
        connectorVersion: connector.version,
        name: definition.name,
        status: definition.status,
        selectedScopes: ["openid", "email"],
        expiresAt: definition.expiresAt,
      },
    });
  }
}

async function upsertDevelopmentEncryptedValue(input: {
  id: string;
  keyId: string;
  keyVersion: string;
  material: Buffer;
  context: string;
  plaintext: string;
}) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.material, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([1, input.keyId, input.keyVersion, input.context])));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const data = {
    keyId: input.keyId,
    keyVersion: input.keyVersion,
    formatVersion: 1,
    context: input.context,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  await db.encryptedValue.upsert({
    where: { id: input.id },
    create: { id: input.id, ...data },
    update: data,
  });
}

function developmentManagedKey(name: string): Buffer {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for development connector seeds. Regenerate .env with pnpm secrets:generate.`,
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(`${name} must be a canonical base64-encoded 32-byte key.`);
  }
  return key;
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
