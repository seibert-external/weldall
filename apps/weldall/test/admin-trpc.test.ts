import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { WELDALL_ISSUER } from "../src/server/oauth/constants.js";
import { ADMIN_SCOPE_KEY } from "../src/server/admin/service.js";
import { createGroupProvider, updateGroupProvider } from "../src/server/group-providers/service.js";
import type { TrpcContext } from "../src/server/trpc/context.js";
import { appRouter, assertBrowserRequest } from "../src/server/trpc/router.js";

const runId = randomUUID();
const adminUserId = `trpc-admin-${runId}`;
const normalUserId = `trpc-normal-${runId}`;
const adminEmail = `trpc-admin-${runId}@example.com`;
const normalEmail = `trpc-normal-${runId}@example.com`;
const affectedEmail = `trpc-affected-${runId}@example.com`;
let assignmentId: string;
let adminScopeId: string;
let adminProviderUnavailable = false;

describe("admin tRPC middleware", () => {
  beforeAll(async () => {
    process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (adminProviderUnavailable) return new Response(null, { status: 503 });
      if (url.includes("/api/management/users/?mail=")) {
        return Response.json(
          url.includes(encodeURIComponent(adminEmail))
            ? [{ username: "group-admin", email: adminEmail, is_active: true }]
            : [],
        );
      }
      if (url.endsWith("/api/management/users/group-admin/")) {
        return Response.json({
          username: "group-admin",
          email: adminEmail,
          is_active: true,
          groups: ["admins"],
        });
      }
      return new Response(null, { status: 404 });
    });
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
    const occurredAt = new Date("2026-01-15T12:00:00.000Z");
    await db.auditEvent.createMany({
      data: ["a", "b"].map((suffix) => ({
        id: `trpc-audit-${runId}-${suffix}`,
        eventType: "id_jag.denied",
        occurredAt,
        actorType: "user",
        actorId: adminUserId,
        actorEmail: adminEmail,
        clientId: "weldall-cli",
        requestId: `trpc-audit-${suffix}-${runId}`,
        outcome: "denied",
        reasonCode: "scope_not_granted",
        subjectType: "resource",
        subjectId: "https://resource.example/api",
        metadata: {
          audience: "https://resource.example",
          resource: "https://resource.example/api",
          requestedScopes: ["example:read"],
        },
      })),
    });
    await db.auditEvent.create({
      data: {
        id: `trpc-audit-${runId}-affected`,
        eventType: "user_scopes.created",
        occurredAt,
        actorType: "user",
        actorId: adminUserId,
        actorEmail: adminEmail,
        requestId: `trpc-audit-affected-${runId}`,
        outcome: "success",
        subjectType: "email_scope_assignment",
        subjectId: `assignment-${runId}`,
        metadata: {
          normalizedEmail: affectedEmail,
          beforeScopes: [],
          afterScopes: ["example:read"],
          addedScopes: ["example:read"],
          removedScopes: [],
          source: "admin_api",
          versionBefore: 0,
          versionAfter: 1,
        },
      },
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.emailScopeAssignment.deleteMany({
      where: { normalizedEmail: { in: [adminEmail, normalEmail] } },
    });
    await db.groupProvider.deleteMany({ where: { key: { startsWith: `trpc-${runId}` } } });
    await db.auditEvent.deleteMany({ where: { actorId: adminUserId } });
    await db.user.deleteMany({ where: { id: { in: [adminUserId, normalUserId] } } });
  });

  it("rejects anonymous and non-admin callers", async () => {
    await expect(caller().admin.status()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller(normalUserId).admin.status()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller(normalUserId).admin.auditEvents.list({
        page: 1,
        pageSize: 20,
        sort: "occurredAt.desc",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists users and resolves user details for administrators", async () => {
    await expect(
      caller(adminUserId).admin.users.list({
        page: 1,
        pageSize: 20,
        q: normalEmail,
        sort: "createdAt.desc",
      }),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ id: normalUserId, email: normalEmail, name: "tRPC User" }],
    });
    await expect(caller(adminUserId).admin.users.get({ id: normalUserId })).resolves.toMatchObject({
      id: normalUserId,
      email: normalEmail,
    });
    await expect(caller(adminUserId).admin.users.get({ id: "missing-user" })).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );
  });

  it("resolves assignment details for administrators", async () => {
    await expect(
      caller(adminUserId).admin.assignments.get({ id: assignmentId }),
    ).resolves.toMatchObject({
      id: assignmentId,
      email: adminEmail,
      scopes: [ADMIN_SCOPE_KEY],
    });
    await expect(
      caller(adminUserId).admin.assignments.get({ id: "missing-assignment" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("authorizes group-derived administration and checks revocation fail-closed", async () => {
    await expect(caller(adminUserId).admin.status()).resolves.toMatchObject({
      authenticated: true,
      email: adminEmail,
    });
    let provider = await createGroupProvider(
      {
        key: `trpc-${runId}-admin-provider`,
        name: "tRPC admin provider",
        adapterType: "management-api-v1",
        baseUrl: "https://trpc-admin-provider.example",
        token: "trpc-admin-token",
        enabled: true,
      },
      { id: adminUserId, email: adminEmail, requestId: `trpc-${runId}-admin-provider` },
    );
    const groupAssignment = await db.groupScopeAssignment.create({
      data: {
        providerId: provider.id,
        groupId: "admins",
        groupName: "Admins",
        createdBy: adminUserId,
        updatedBy: adminUserId,
        grants: { create: { scopeId: adminScopeId, createdBy: adminUserId } },
      },
    });
    await db.emailScopeGrant.deleteMany({ where: { assignmentId } });
    await expect(caller(adminUserId).admin.status()).resolves.toMatchObject({
      authenticated: true,
      email: adminEmail,
    });

    adminProviderUnavailable = true;
    await expect(caller(adminUserId).admin.status()).rejects.toMatchObject({ code: "FORBIDDEN" });
    adminProviderUnavailable = false;
    provider = await updateGroupProvider(
      {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled: false,
        expectedVersion: provider.version,
      },
      { id: adminUserId, email: adminEmail, requestId: `trpc-${runId}-disable-provider` },
    );
    await expect(caller(adminUserId).admin.status()).rejects.toMatchObject({ code: "FORBIDDEN" });

    await db.groupScopeAssignment.delete({ where: { id: groupAssignment.id } });
    await db.groupProvider.delete({ where: { id: provider.id } });
    await db.emailScopeGrant.create({
      data: {
        id: randomUUID(),
        assignmentId,
        scopeId: adminScopeId,
        createdBy: "admin-trpc-test",
      },
    });
  });

  it("exposes protected system scopes through assignment option APIs", async () => {
    const options = await caller(adminUserId).admin.scopes.options();
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "weldall:administer", isSystem: true }),
        expect.objectContaining({ key: "weldall:login", isSystem: true }),
      ]),
    );
  });

  it("filters and stably paginates audit events for administrators", async () => {
    const firstPage = await caller(adminUserId).admin.auditEvents.list({
      page: 1,
      pageSize: 1,
      from: "2026-01-15T00:00:00.000Z",
      to: "2026-01-15T23:59:59.999Z",
      eventType: "id_jag.denied",
      email: adminEmail.slice(0, 16),
      sort: "occurredAt.asc",
    });
    const secondPage = await caller(adminUserId).admin.auditEvents.list({
      page: 2,
      pageSize: 1,
      from: "2026-01-15T00:00:00.000Z",
      to: "2026-01-15T23:59:59.999Z",
      eventType: "id_jag.denied",
      email: adminEmail.slice(0, 16),
      sort: "occurredAt.asc",
    });
    expect(firstPage.total).toBe(2);
    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.items).toHaveLength(1);
    expect(firstPage.items[0]!.id < secondPage.items[0]!.id).toBe(true);
    await expect(
      caller(adminUserId).admin.auditEvents.get({ id: firstPage.items[0]!.id }),
    ).resolves.toMatchObject({ actorEmail: adminEmail, eventType: "id_jag.denied" });
    await expect(
      caller(adminUserId).admin.auditEvents.list({
        page: 1,
        pageSize: 20,
        userId: adminUserId,
        eventType: "id_jag.denied",
        outcome: "denied",
        sort: "occurredAt.desc",
      }),
    ).resolves.toMatchObject({
      total: 2,
      items: [
        expect.objectContaining({ actorId: adminUserId, eventType: "id_jag.denied" }),
        expect.objectContaining({ actorId: adminUserId, eventType: "id_jag.denied" }),
      ],
    });

    await expect(
      caller(adminUserId).admin.auditEvents.list({
        page: 1,
        pageSize: 20,
        eventType: "user_scopes.created",
        email: affectedEmail.slice(0, 20),
        sort: "occurredAt.desc",
      }),
    ).resolves.toMatchObject({ total: 1 });
  });

  it("exposes provider administration without ever returning the credential", async () => {
    const created = await caller(adminUserId).admin.groupProviders.create({
      key: `trpc-${runId}`,
      name: "tRPC provider",
      adapterType: "management-api-v1",
      baseUrl: "https://groups.example/",
      token: "must-never-be-returned",
      enabled: true,
    });
    expect(created).toMatchObject({
      key: `trpc-${runId}`,
      baseUrl: "https://groups.example",
      hasToken: true,
    });
    expect(JSON.stringify(created)).not.toContain("must-never-be-returned");
    const listed = await caller(adminUserId).admin.groupProviders.list();
    expect(JSON.stringify(listed)).not.toContain("encryptedToken");
    expect(JSON.stringify(listed)).not.toContain("must-never-be-returned");

    const scope = await db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } });
    const assignment = await db.groupScopeAssignment.create({
      data: {
        providerId: created.id,
        groupId: `trpc-group-${runId}`,
        groupName: "tRPC group",
        createdBy: adminUserId,
        updatedBy: adminUserId,
        grants: { create: { scopeId: scope.id, createdBy: adminUserId } },
      },
    });
    await expect(
      caller(adminUserId).admin.groupAssignments.get({ id: assignment.id }),
    ).resolves.toMatchObject({
      id: assignment.id,
      providerId: created.id,
      groupName: "tRPC group",
      scopes: ["expenses:read"],
    });
    await expect(
      caller(adminUserId).admin.groupAssignments.get({ id: "missing-group-assignment" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.groupScopeAssignment.delete({ where: { id: assignment.id } });

    await caller(adminUserId).admin.groupProviders.delete({
      id: created.id,
      expectedVersion: created.version,
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
