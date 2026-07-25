import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { WELDALL_ISSUER } from "../src/server/oauth/constants.js";
import { ADMIN_SCOPE_KEY } from "../src/server/admin/service.js";
import type { TrpcContext } from "../src/server/trpc/context.js";
import { appRouter, assertBrowserRequest } from "../src/server/trpc/router.js";

const runId = randomUUID();
const adminUserId = `trpc-admin-${runId}`;
const normalUserId = `trpc-normal-${runId}`;
const adminEmail = `trpc-admin-${runId}@example.com`;
const normalEmail = `trpc-normal-${runId}@example.com`;
let assignmentId: string;
let adminScopeId: string;

describe("admin tRPC middleware", () => {
  beforeAll(async () => {
    const adminScope = await db.scope.findUniqueOrThrow({
      where: { key: ADMIN_SCOPE_KEY },
    });
    adminScopeId = adminScope.id;
    await db.user.createMany({
      data: [
        {
          id: adminUserId,
          name: "tRPC Admin",
          email: adminEmail,
          emailVerified: true,
        },
        {
          id: normalUserId,
          name: "tRPC User",
          email: normalEmail,
          emailVerified: true,
        },
      ],
    });
    const assignment = await db.emailScopeAssignment.create({
      data: {
        normalizedEmail: adminEmail,
        createdBy: "admin-trpc-test",
        updatedBy: "admin-trpc-test",
        grants: {
          create: {
            id: randomUUID(),
            scopeId: adminScope.id,
            createdBy: "admin-trpc-test",
          },
        },
      },
    });
    assignmentId = assignment.id;
  });

  afterAll(async () => {
    await db.emailScopeAssignment.deleteMany({
      where: { normalizedEmail: { in: [adminEmail, normalEmail] } },
    });
    await db.user.deleteMany({ where: { id: { in: [adminUserId, normalUserId] } } });
  });

  it("rejects anonymous and non-admin callers", async () => {
    await expect(caller().admin.status()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller(normalUserId).admin.status()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("checks the live assignment on every procedure call", async () => {
    await expect(caller(adminUserId).admin.status()).resolves.toMatchObject({
      authenticated: true,
      email: adminEmail,
    });
    await db.emailScopeGrant.deleteMany({ where: { assignmentId } });
    await expect(caller(adminUserId).admin.status()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await db.emailScopeGrant.create({
      data: {
        id: randomUUID(),
        assignmentId,
        scopeId: adminScopeId,
        createdBy: "admin-trpc-test",
      },
    });
  });

  it("accepts same-origin JSON requests with the CSRF header", () => {
    const request = new Request(`${WELDALL_ISSUER}/api/trpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: WELDALL_ISSUER,
        "sec-fetch-site": "same-origin",
        "x-weldall-csrf": "1",
      },
      body: "{}",
    });
    expect(() => assertBrowserRequest(request)).not.toThrow();
  });

  it.each([
    {
      name: "foreign origins",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "x-weldall-csrf": "1",
      },
    },
    {
      name: "a missing CSRF header",
      headers: { "content-type": "application/json", origin: WELDALL_ISSUER },
    },
    {
      name: "non-JSON requests",
      headers: {
        "content-type": "text/plain",
        origin: WELDALL_ISSUER,
        "x-weldall-csrf": "1",
      },
    },
  ])("rejects $name", ({ headers }) => {
    expect(() =>
      assertBrowserRequest(
        new Request(`${WELDALL_ISSUER}/api/trpc`, {
          method: "POST",
          headers,
          body: "{}",
        }),
      ),
    ).toThrow("Invalid request origin");
  });
});

function caller(userId?: string) {
  return appRouter.createCaller({
    request: new Request(`${WELDALL_ISSUER}/api/trpc`),
    requestId: randomUUID(),
    session: userId ? ({ user: { id: userId } } as TrpcContext["session"]) : null,
  });
}
