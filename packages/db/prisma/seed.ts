import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const actor = "production-seed";

export async function seedProduction(prisma: PrismaClient = db): Promise<void> {
  const issuer = new URL(process.env.WELDALL_ISSUER ?? "https://weldall.seibert.localdev");
  const resourceIdentifier = `${issuer.origin}/api`;
  const oauthScopes = ["openid", "profile", "email", "offline_access", "weldall:scopes"];

  await prisma.$transaction([
    prisma.oauthClient.upsert({
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
    }),
    prisma.oauthResource.upsert({
      where: { id: "weldall-api" },
      create: {
        id: "weldall-api",
        identifier: resourceIdentifier,
        name: "Weldall API",
        signingAlgorithm: "ES256",
        allowedScopes: oauthScopes,
        dpopBoundAccessTokensRequired: true,
      },
      update: {
        identifier: resourceIdentifier,
        name: "Weldall API",
        signingAlgorithm: "ES256",
        allowedScopes: oauthScopes,
        dpopBoundAccessTokensRequired: true,
        disabled: false,
      },
    }),
    prisma.scope.upsert({
      where: { key: "weldall:administer" },
      create: {
        id: "scope-weldall-administer",
        key: "weldall:administer",
        description: "Administer Weldall scopes and assignments.",
        isSystem: true,
        createdBy: actor,
        updatedBy: actor,
      },
      update: { isSystem: true, updatedBy: actor },
    }),
    prisma.cliSettings.upsert({
      where: { id: "default" },
      create: { id: "default", createdBy: actor, updatedBy: actor },
      update: {},
    }),
  ]);
}

try {
  await seedProduction();
} finally {
  await db.$disconnect();
}
