import type { Prisma, PrismaClient } from "@prisma/client";
import { db, ensureSystemScopes } from "@weldall/db";
import { decryptProviderToken } from "./group-providers/credentials";
import { WELDALL_RESOURCE } from "./oauth/constants";
import { readConnectorSecrets } from "./connectors/configuration";
import { getConnectorProvider } from "./connectors/registry";
import { decrypt, encrypt } from "./connectors/encryption";

const LOCAL_WELDALL_RESOURCE = "https://weldall.seibert.localdev/api";
const LOCAL_EXPENSES_RESOURCE = "https://expenses.seibert.localdev/api";

export async function prepareProductionDatabase(prisma: PrismaClient = db): Promise<void> {
  const actor = "deployment-bootstrap";
  const oauthScopes = ["openid", "profile", "email", "offline_access", "weldall:scopes"];

  await prisma.$transaction(async (tx) => {
    await ensureSystemScopes(tx, actor);
    const conflictingResource = await tx.oauthResource.findUnique({
      where: { identifier: WELDALL_RESOURCE },
    });
    if (conflictingResource && conflictingResource.id !== "weldall-api") {
      await tx.oauthResource.delete({ where: { id: conflictingResource.id } });
    }
    await tx.oauthClient.upsert({
      where: { clientId: "weldall-cli" },
      create: {
        id: "weldall-cli",
        clientId: "weldall-cli",
        disabled: false,
        skipConsent: false,
        scopes: oauthScopes,
        name: "Weldall CLI",
        redirectUris: ["http://127.0.0.1/callback"],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        public: true,
        type: "native",
        requirePKCE: true,
        dpopBoundAccessTokens: true,
      },
      update: {
        disabled: false,
        skipConsent: false,
        scopes: oauthScopes,
        dpopBoundAccessTokens: true,
      },
    });
    await tx.oauthResource.upsert({
      where: { id: "weldall-api" },
      create: {
        id: "weldall-api",
        identifier: WELDALL_RESOURCE,
        name: "Weldall API",
        signingAlgorithm: "ES256",
        allowedScopes: oauthScopes,
        dpopBoundAccessTokensRequired: true,
      },
      update: {
        identifier: WELDALL_RESOURCE,
        name: "Weldall API",
        signingAlgorithm: "ES256",
        allowedScopes: oauthScopes,
        dpopBoundAccessTokensRequired: true,
        disabled: false,
      },
    });
    await tx.cliSettings.upsert({
      where: { id: "default" },
      create: { id: "default", logoUrl: "", createdBy: actor, updatedBy: actor },
      update: {},
    });
    if (WELDALL_RESOURCE !== LOCAL_WELDALL_RESOURCE) {
      await tx.downstreamResource.updateMany({
        where: {
          resourceIdentifier: {
            in: [LOCAL_EXPENSES_RESOURCE, "https://development-skills.seibert.localdev/api"],
          },
          enabled: true,
        },
        data: {
          enabled: false,
          skillDiscoveryEnabled: false,
          version: { increment: 1 },
          updatedBy: actor,
        },
      });
    }
  });

  const providers = await prisma.groupProvider.findMany({
    select: { id: true, encryptedToken: true, encryptionKeyVersion: true },
  });
  for (const provider of providers) decryptProviderToken(provider);
  await verifyConnectorEncryption(prisma);
}

/** Fail readiness on unavailable deployment keys or unrestorable ciphertext, in bounded batches. */
export async function verifyConnectorEncryption(prisma: PrismaClient = db): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const connectors = await prisma.connector.findMany({
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!connectors.length) break;
    for (const connector of connectors) {
      await encrypt({
        provider: connector.envelopeProvider,
        plaintext: "readiness",
        context: "readiness",
      });
      getConnectorProvider(connector.providerType).parseConfiguration(connector.providerConfig);
      if (connector.encryptedProviderSecrets) readConnectorSecrets(connector);
    }
    cursor = connectors.at(-1)!.id;
  }
  cursor = undefined;
  for (;;) {
    const values: Prisma.EncryptedValueGetPayload<{
      include: { connection: { select: { id: true } }; attempt: { select: { id: true } } };
    }>[] = await prisma.encryptedValue.findMany({
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { connection: { select: { id: true } }, attempt: { select: { id: true } } },
    });
    if (!values.length) break;
    for (const value of values) {
      const context = value.connection
        ? `connection:${value.connection.id}:credentials`
        : value.attempt
          ? `attempt:${value.attempt.id}:oauth`
          : null;
      if (!context) throw new Error("Connector ciphertext has no owning record.");
      await decrypt({ envelope: value, context });
    }
    cursor = values.at(-1)!.id;
  }
}
