import type { PrismaClient } from "@prisma/client";
import { ADMIN_SCOPE_KEY, db, ensureSystemScopes } from "@weldall/db";
import { bootstrapAdmin } from "./admin/service";
import { decryptProviderToken } from "./group-providers/credentials";
import { WELDALL_RESOURCE } from "./oauth/constants";
import {
  reconcileResourceBrowserClient,
  revokeResourceBrowserState,
} from "./oauth/browser-resources";

const LOCAL_WELDALL_RESOURCE = "https://weldall.seibert.localdev/api";
const LOCAL_EXPENSES_RESOURCE = "https://expenses.seibert.localdev/api";

type BootstrapAdmin = typeof bootstrapAdmin;

export async function bootstrapConfiguredAdmin(
  email: string,
  prisma: PrismaClient = db,
  bootstrap: BootstrapAdmin = bootstrapAdmin,
): Promise<Awaited<ReturnType<BootstrapAdmin>> | null> {
  const existingAdmin = await prisma.emailScopeGrant.findFirst({
    where: { scope: { key: ADMIN_SCOPE_KEY } },
    select: { id: true },
  });
  if (existingAdmin) return null;
  return bootstrap(email);
}

export async function prepareProductionDatabase(
  prisma: PrismaClient = db,
  options: { deploymentResource?: string } = {},
): Promise<void> {
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
      create: { id: "default", createdBy: actor, updatedBy: actor },
      update: {},
    });
    if ((options.deploymentResource ?? WELDALL_RESOURCE) !== LOCAL_WELDALL_RESOURCE) {
      const developmentResources = await tx.downstreamResource.findMany({
        where: {
          resourceIdentifier: {
            in: [LOCAL_EXPENSES_RESOURCE, "https://development-skills.seibert.localdev/api"],
          },
          enabled: true,
        },
        include: { requestPrefixes: { select: { urlPrefix: true } } },
      });
      for (const resource of developmentResources) {
        const disabled = await tx.downstreamResource.update({
          where: { id: resource.id },
          data: {
            enabled: false,
            skillDiscoveryEnabled: false,
            version: { increment: 1 },
            updatedBy: actor,
          },
          include: { requestPrefixes: { select: { urlPrefix: true } } },
        });
        await reconcileResourceBrowserClient(tx, disabled);
        await revokeResourceBrowserState(tx, disabled, {
          actorId: actor,
          actorType: "machine",
          requestId: "deployment-bootstrap",
          reason: "resource_disabled",
        });
      }
    }
    const resources = await tx.downstreamResource.findMany({
      include: { requestPrefixes: { select: { urlPrefix: true } } },
    });
    for (const resource of resources) await reconcileResourceBrowserClient(tx, resource);
  });

  const providers = await prisma.groupProvider.findMany({
    select: { id: true, encryptedToken: true, encryptionKeyVersion: true },
  });
  for (const provider of providers) decryptProviderToken(provider);
}
