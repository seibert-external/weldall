import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { ensureSystemScopes } from "../src/system-scopes.js";

const db = new PrismaClient();
const actor = "production-seed";

export async function seedProduction(prisma: PrismaClient = db): Promise<void> {
  const issuer = new URL(process.env.WELDALL_ISSUER ?? "https://weldall.seibert.localdev");
  const resourceIdentifier = `${issuer.origin}/api`;
  const oauthScopes = ["openid", "profile", "email", "offline_access", "weldall:scopes"];

  await prisma.$transaction(async (tx) => {
    await ensureSystemScopes(tx, actor);
    await Promise.all([
      tx.loginInstallation.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: {},
      }),
      tx.installationIdentity.upsert({
        where: { id: "default" },
        create: { id: "default", installationId: randomUUID() },
        update: {},
      }),
      tx.oauthClient.upsert({
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
      tx.oauthResource.upsert({
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
      tx.cliSettings.upsert({
        where: { id: "default" },
        create: { id: "default", logoUrl: "", createdBy: actor, updatedBy: actor },
        update: {},
      }),
    ]);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await seedProduction();
  } finally {
    await db.$disconnect();
  }
}
