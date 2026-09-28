import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_SCOPE_KEY, db, ensureSystemScopes, STATISTICS_SCOPE_KEY } from "@weldall/db";
import { WELDALL_ISSUER } from "../src/server/oauth/constants.js";
import { canViewStatistics } from "../src/server/statistics/access.js";
import { appRouter } from "../src/server/trpc/router.js";
import type { TrpcContext } from "../src/server/trpc/context.js";

const runId = randomUUID();
const actorId = `statistics-trpc-${runId}`;
const viewerEmail = `statistics-viewer-${runId}@example.com`;
const adminEmail = `statistics-admin-${runId}@example.com`;
const outsiderEmail = `statistics-outsider-${runId}@example.com`;

async function grant(normalizedEmail: string, scopeKey: string) {
  const scope = await db.scope.findUniqueOrThrow({ where: { key: scopeKey } });
  await db.emailScopeAssignment.create({
    data: {
      normalizedEmail,
      createdBy: actorId,
      updatedBy: actorId,
      grants: { create: { scopeId: scope.id, createdBy: actorId } },
    },
  });
}

beforeAll(async () => {
  await ensureSystemScopes(db, actorId);
  await grant(viewerEmail, STATISTICS_SCOPE_KEY);
  await grant(adminEmail, ADMIN_SCOPE_KEY);
});

afterAll(async () => {
  await db.emailScopeAssignment.deleteMany({
    where: { normalizedEmail: { in: [viewerEmail, adminEmail] } },
  });
});

function caller(email?: string) {
  return appRouter.createCaller({
    request: new Request(`${WELDALL_ISSUER}/api/trpc`),
    requestId: randomUUID(),
    session: email ? ({ user: { id: `session-${email}`, email } } as TrpcContext["session"]) : null,
  });
}

describe("statistics access", () => {
  it("requires the statistics scope and normalizes the email", async () => {
    await expect(canViewStatistics(viewerEmail)).resolves.toBe(true);
    await expect(canViewStatistics(`  ${viewerEmail.toUpperCase()} `)).resolves.toBe(true);
    await expect(canViewStatistics(outsiderEmail)).resolves.toBe(false);
    await expect(canViewStatistics("not an email")).resolves.toBe(false);
  });

  it("does not treat weldall:administer as statistics access", async () => {
    await expect(canViewStatistics(adminEmail)).resolves.toBe(false);
  });
});

describe("statistics tRPC router", () => {
  it("requires a signed-in session", async () => {
    await expect(caller().statistics.summary({ interval: "7d" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects people without the statistics scope, admins included", async () => {
    for (const email of [outsiderEmail, adminEmail]) {
      await expect(caller(email).statistics.summary({ interval: "7d" })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Statistics access is required.",
      });
    }
  });

  it("returns the statistics for the requested interval", async () => {
    const statistics = await caller(viewerEmail).statistics.summary({ interval: "30d" });

    expect(statistics.interval).toBe("30d");
    expect(statistics).toEqual(
      expect.objectContaining({
        activeHumans: expect.objectContaining({ count: expect.any(Number) }),
        machines: { count: expect.any(Number) },
        resources: expect.any(Array),
        skills: expect.any(Array),
      }),
    );
  });

  it("rejects intervals outside the four supported values", async () => {
    await expect(
      caller(viewerEmail).statistics.summary({ interval: "1y" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
