import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { ensureSystemScopes } from "../src/system-scopes.js";

const db = new PrismaClient();
const actor = "production-seed";
const browserScopes = ["openid", "profile", "email", "offline_access", "weldall:scopes"];
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const tokenExchangeGrant = "urn:ietf:params:oauth:grant-type:token-exchange";

async function reconcileBrowserClients(tx: Prisma.TransactionClient) {
  const resources = await tx.downstreamResource.findMany({
    include: { requestPrefixes: { select: { urlPrefix: true } } },
  });
  for (const resource of resources) {
    const clientId = `weldall-browser:${resource.key}`;
    const origins = [
      ...new Set([
        new URL(resource.authorizationServer).origin,
        ...resource.requestPrefixes.map(({ urlPrefix }) => new URL(urlPrefix).origin),
      ]),
    ].sort();
    const existing = await tx.oauthClient.findUnique({ where: { clientId } });
    if (existing && (existing.id !== clientId || existing.referenceId !== resource.id))
      throw new Error(`Browser client ${clientId} is already bound to another resource`);
    await tx.oauthClient.upsert({
      where: { clientId },
      create: {
        id: clientId,
        clientId,
        disabled: !resource.enabled,
        skipConsent: true,
        enableEndSession: false,
        scopes: browserScopes,
        name: `${resource.name} browser`,
        uri: origins[0],
        redirectUris: [],
        postLogoutRedirectUris: [],
        tokenEndpointAuthMethod: "none",
        grantTypes: [deviceGrant, "refresh_token", tokenExchangeGrant],
        responseTypes: [],
        public: true,
        type: "web",
        requirePKCE: false,
        dpopBoundAccessTokens: true,
        referenceId: resource.id,
        metadata: {
          weldallBrowser: {
            schemaVersion: 1,
            resourceId: resource.id,
            resourceKey: resource.key,
            resourceIdentifier: resource.resourceIdentifier,
            allowedOrigins: origins,
          },
        },
      },
      update: {
        clientSecret: null,
        disabled: !resource.enabled,
        skipConsent: true,
        enableEndSession: false,
        scopes: browserScopes,
        userId: null,
        name: `${resource.name} browser`,
        uri: origins[0],
        redirectUris: [],
        postLogoutRedirectUris: [],
        tokenEndpointAuthMethod: "none",
        jwks: null,
        jwksUri: null,
        grantTypes: [deviceGrant, "refresh_token", tokenExchangeGrant],
        responseTypes: [],
        public: true,
        type: "web",
        requirePKCE: false,
        dpopBoundAccessTokens: true,
        referenceId: resource.id,
        metadata: {
          weldallBrowser: {
            schemaVersion: 1,
            resourceId: resource.id,
            resourceKey: resource.key,
            resourceIdentifier: resource.resourceIdentifier,
            allowedOrigins: origins,
          },
        },
      },
    });
  }
}

export async function seedProduction(prisma: PrismaClient = db): Promise<void> {
  const issuer = new URL(process.env.WELDALL_ISSUER ?? "https://weldall.seibert.localdev");
  const resourceIdentifier = `${issuer.origin}/api`;
  const oauthScopes = ["openid", "profile", "email", "offline_access", "weldall:scopes"];

  await prisma.$transaction(async (tx) => {
    await ensureSystemScopes(tx, actor);
    await Promise.all([
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
        create: { id: "default", createdBy: actor, updatedBy: actor },
        update: {},
      }),
    ]);
    await reconcileBrowserClients(tx);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await seedProduction();
  } finally {
    await db.$disconnect();
  }
}
