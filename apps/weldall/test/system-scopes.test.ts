import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADMIN_SCOPE_KEY,
  db,
  ensureSystemScopes,
  IAC_SCOPE_KEY,
  LOGIN_SCOPE_KEY,
  Prisma,
  SYSTEM_SCOPE_DEFINITIONS,
} from "@weldall/db";
import { seedProduction } from "../../../packages/db/prisma/seed.js";
import { prepareProductionDatabase } from "../src/server/deployment.js";
import { reconcileResourceBrowserClient } from "../src/server/oauth/browser-resources.js";

const rollback = new Error("rollback system scope test");

describe("built-in system scope provisioning", () => {
  it("creates missing system scopes and reruns without granting login", async () => {
    const grantsBefore = await db.emailScopeGrant.count({
      where: { scope: { key: LOGIN_SCOPE_KEY } },
    });

    await expect(
      db.$transaction(async (tx) => {
        await tx.emailScopeGrant.deleteMany({ where: { scope: { key: LOGIN_SCOPE_KEY } } });
        await tx.scope.deleteMany({ where: { key: LOGIN_SCOPE_KEY } });

        await ensureSystemScopes(tx, "system-scope-test-first");
        await ensureSystemScopes(tx, "system-scope-test-second");

        const scopes = await tx.scope.findMany({
          where: { key: { in: [ADMIN_SCOPE_KEY, IAC_SCOPE_KEY, LOGIN_SCOPE_KEY] } },
          orderBy: { key: "asc" },
        });
        expect(scopes).toHaveLength(SYSTEM_SCOPE_DEFINITIONS.length);
        expect(scopes).toEqual(
          expect.arrayContaining(
            SYSTEM_SCOPE_DEFINITIONS.map((definition) =>
              expect.objectContaining({
                id: definition.id,
                key: definition.key,
                description: definition.description,
                isSystem: true,
                updatedBy: "system-scope-test-second",
              }),
            ),
          ),
        );
        await expect(
          tx.emailScopeGrant.count({ where: { scope: { key: LOGIN_SCOPE_KEY } } }),
        ).resolves.toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    await expect(
      db.emailScopeGrant.count({ where: { scope: { key: LOGIN_SCOPE_KEY } } }),
    ).resolves.toBe(grantsBefore);
  });

  it.each([ADMIN_SCOPE_KEY, IAC_SCOPE_KEY, LOGIN_SCOPE_KEY])(
    "fails closed instead of promoting a user-created %s collision",
    async (key) => {
      await expect(
        db.$transaction(async (tx) => {
          await tx.emailScopeGrant.deleteMany({ where: { scope: { key } } });
          await tx.machineAllowedScope.deleteMany({ where: { scope: { key } } });
          await tx.resourceScope.deleteMany({ where: { scope: { key } } });
          await tx.scope.deleteMany({ where: { key } });
          await tx.scope.create({
            data: {
              key,
              description: "User-created collision.",
              createdBy: "system-scope-test",
              updatedBy: "system-scope-test",
            },
          });
          await expect(ensureSystemScopes(tx, "system-scope-test")).rejects.toThrow(
            `System scope collision for ${key}.`,
          );
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );

  it("keeps the production seed and deployment initializer idempotent without adding grants", async () => {
    await expect(
      db.$transaction(async (tx) => {
        const grantsBefore = await tx.emailScopeGrant.count({
          where: { scope: { key: LOGIN_SCOPE_KEY } },
        });
        const prisma = {
          $transaction: async (operation: (nested: Prisma.TransactionClient) => Promise<unknown>) =>
            operation(tx),
          groupProvider: { findMany: async () => [] },
        } as unknown as PrismaClient;
        const resourceKey = `seed-browser-${Date.now()}`;
        const resource = await tx.downstreamResource.create({
          data: {
            key: resourceKey,
            name: "Seed browser",
            resourceIdentifier: `https://${resourceKey}.example/api`,
            authorizationServer: `https://${resourceKey}.example`,
            downstreamClientId: `downstream-${resourceKey}`,
            createdBy: "system-scope-test",
            updatedBy: "system-scope-test",
            requestPrefixes: {
              create: {
                urlPrefix: `https://${resourceKey}.example/api`,
                createdBy: "system-scope-test",
              },
            },
          },
        });

        await seedProduction(prisma);
        await tx.oauthClient.update({
          where: { clientId: `weldall-browser:${resourceKey}` },
          data: {
            redirectUris: ["https://attacker.example/callback"],
            tokenEndpointAuthMethod: "client_secret_post",
            requirePKCE: true,
            dpopBoundAccessTokens: false,
          },
        });
        await seedProduction(prisma);
        await prepareProductionDatabase(prisma);
        await prepareProductionDatabase(prisma);

        await expect(
          tx.scope.count({ where: { key: LOGIN_SCOPE_KEY, isSystem: true } }),
        ).resolves.toBe(1);
        await expect(
          tx.emailScopeGrant.count({ where: { scope: { key: LOGIN_SCOPE_KEY } } }),
        ).resolves.toBe(grantsBefore);
        await expect(
          tx.oauthClient.findUniqueOrThrow({
            where: { clientId: `weldall-browser:${resourceKey}` },
          }),
        ).resolves.toMatchObject({
          referenceId: resource.id,
          redirectUris: [],
          responseTypes: [],
          tokenEndpointAuthMethod: "none",
          requirePKCE: false,
          dpopBoundAccessTokens: true,
          disabled: false,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("disables development resources and revokes their complete browser lifecycle in production", async () => {
    await expect(
      db.$transaction(async (tx) => {
        const suffix = Date.now().toString(36);
        const existing = await tx.downstreamResource.findUnique({
          where: { resourceIdentifier: "https://expenses.seibert.localdev/api" },
        });
        const resource = existing
          ? await tx.downstreamResource.update({
              where: { id: existing.id },
              data: { enabled: true, updatedBy: "system-scope-test" },
              include: { requestPrefixes: { select: { urlPrefix: true } } },
            })
          : await tx.downstreamResource.create({
              data: {
                key: `deployment-expenses-${suffix}`,
                name: "Development Expenses",
                resourceIdentifier: "https://expenses.seibert.localdev/api",
                authorizationServer: "https://expenses.seibert.localdev",
                downstreamClientId: `expenses-${suffix}`,
                createdBy: "system-scope-test",
                updatedBy: "system-scope-test",
                requestPrefixes: {
                  create: {
                    urlPrefix: "https://expenses.seibert.localdev/api",
                    createdBy: "system-scope-test",
                  },
                },
              },
              include: { requestPrefixes: { select: { urlPrefix: true } } },
            });
        await reconcileResourceBrowserClient(tx, resource);
        const clientId = `weldall-browser:${resource.key}`;
        const jkt = "A".repeat(43);
        const connection = await tx.browserConnection.create({
          data: {
            providerReferenceId: `deployment-reference-${suffix}`,
            browserClientId: clientId,
            oauthClientId: clientId,
            resourceId: resource.id,
            resourceKey: resource.key,
            resourceIdentifier: resource.resourceIdentifier,
            origin: "https://expenses.seibert.localdev",
            userId: `deployment-user-${suffix}`,
            dpopJkt: jkt,
            refreshFamilyId: `deployment-family-${suffix}`,
            approvedVia: "cli-code",
          },
        });
        const tokenHash = createHash("sha256")
          .update(`deployment-refresh-${suffix}`)
          .digest("base64url");
        await tx.oAuthDeviceRefreshBinding.create({
          data: {
            tokenHash,
            familyId: connection.refreshFamilyId,
            clientId,
            userId: connection.userId,
            dpopJkt: jkt,
            browserConnectionId: connection.id,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        const pending = await tx.browserConnectionRequest.create({
          data: {
            deviceCodeHash: createHash("sha256")
              .update(`deployment-device-${suffix}`)
              .digest("base64url"),
            userCodeHash: createHash("sha256")
              .update(`deployment-user-code-${suffix}`)
              .digest("base64url"),
            browserClientId: clientId,
            oauthClientId: clientId,
            resourceId: resource.id,
            origin: "https://expenses.seibert.localdev",
            dpopJkt: jkt,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        const prisma = {
          $transaction: async (operation: (nested: Prisma.TransactionClient) => Promise<unknown>) =>
            operation(tx),
          groupProvider: { findMany: async () => [] },
        } as unknown as PrismaClient;

        await prepareProductionDatabase(prisma, {
          deploymentResource: "https://weldall.example.com/api",
        });

        await expect(
          tx.downstreamResource.findUniqueOrThrow({ where: { id: resource.id } }),
        ).resolves.toMatchObject({ enabled: false, skillDiscoveryEnabled: false });
        await expect(
          tx.oauthClient.findUniqueOrThrow({ where: { clientId } }),
        ).resolves.toMatchObject({ disabled: true });
        await expect(
          tx.browserConnection.findUniqueOrThrow({ where: { id: connection.id } }),
        ).resolves.toMatchObject({
          state: "REVOKED",
          revocationReason: "resource_disabled",
          revokedAt: expect.any(Date),
        });
        await expect(
          tx.oAuthDeviceRefreshBinding.findUniqueOrThrow({ where: { tokenHash } }),
        ).resolves.toMatchObject({ revokedAt: expect.any(Date) });
        await expect(
          tx.browserConnectionRequest.findUniqueOrThrow({ where: { id: pending.id } }),
        ).resolves.toMatchObject({ status: "DENIED", deniedAt: expect.any(Date) });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
