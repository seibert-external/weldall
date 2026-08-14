import type { PrismaClient } from "@prisma/client";
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
          groupProvider: tx.groupProvider,
        } as unknown as PrismaClient;

        await seedProduction(prisma);
        await seedProduction(prisma);
        await prepareProductionDatabase(prisma);
        await prepareProductionDatabase(prisma);

        await expect(
          tx.scope.count({ where: { key: LOGIN_SCOPE_KEY, isSystem: true } }),
        ).resolves.toBe(1);
        await expect(
          tx.emailScopeGrant.count({ where: { scope: { key: LOGIN_SCOPE_KEY } } }),
        ).resolves.toBe(grantsBefore);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
