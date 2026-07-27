import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import {
  assertAdminCanBeRemoved,
  countVerifiedAdminEmails,
  createResource,
  createScope,
  createSkill,
  deleteScope,
  deleteSkill,
  getAssignmentByEmail,
  getCliSettings,
  getResource,
  listSkills,
  replaceAssignment,
  updateCliSettings,
  updateResource,
  updateSkill,
  type AdminActor,
} from "../src/server/admin/service.js";
import { getVisibleSkill, listVisibleSkills } from "../src/server/skills/service.js";

const runId = randomUUID().replaceAll("-", "");
const namespace = `admintest-${runId}`;
const primaryEmail = `${runId}-primary@example.com`;
const secondaryEmail = `${runId}-secondary@example.com`;
const primaryUserId = `${runId}-primary-user`;
const secondaryUserId = `${runId}-secondary-user`;
const primaryActor: AdminActor = {
  id: primaryUserId,
  email: primaryEmail,
  requestId: `${runId}-primary-request`,
};
const secondaryActor: AdminActor = {
  id: secondaryUserId,
  email: secondaryEmail,
  requestId: `${runId}-secondary-request`,
};
type ResourceInput = Parameters<typeof createResource>[0];
const resourceInput = (
  suffix: string,
  scopeId: string,
  overrides: Partial<ResourceInput> = {},
): ResourceInput => {
  const origin = `https://${namespace}-${suffix}.example`;
  return {
    key: `${namespace}-${suffix}`,
    name: `Resource ${suffix}`,
    resourceIdentifier: `${origin}/resource`,
    authorizationServer: origin,
    downstreamClientId: `client-${suffix}`,
    enabled: true,
    scopeIds: [scopeId],
    requestPrefixes: [`${origin}/api`],
    ...overrides,
  };
};

beforeAll(async () => {
  const adminScope = await db.scope.findUniqueOrThrow({
    where: { key: "weldall:administer" },
  });
  await db.user.createMany({
    data: [
      {
        id: primaryUserId,
        name: "Primary Admin Test",
        email: primaryEmail,
        emailVerified: true,
      },
      {
        id: secondaryUserId,
        name: "Secondary Admin Test",
        email: secondaryEmail,
        emailVerified: true,
      },
    ],
  });
  await db.emailScopeAssignment.create({
    data: {
      normalizedEmail: primaryEmail,
      createdBy: "admin-service-test",
      updatedBy: "admin-service-test",
      grants: {
        create: {
          id: randomUUID(),
          scopeId: adminScope.id,
          createdBy: "admin-service-test",
        },
      },
    },
  });
});

afterAll(async () => {
  await db.emailScopeAssignment.deleteMany({
    where: { normalizedEmail: { contains: runId } },
  });
  await db.downstreamResource.deleteMany({ where: { key: { startsWith: namespace } } });
  await db.scope.deleteMany({ where: { key: { startsWith: namespace } } });
  await db.skill.deleteMany({ where: { slug: { startsWith: namespace } } });
  await db.auditEvent.deleteMany({
    where: { actorId: { in: [primaryUserId, secondaryUserId] } },
  });
  await db.user.deleteMany({ where: { id: { in: [primaryUserId, secondaryUserId] } } });
});

describe("admin scope service", () => {
  it("atomically replaces normalized email assignments and rejects unknown scopes", async () => {
    const scope = await createScope(
      { key: `${namespace}:read`, description: "Read test data." },
      primaryActor,
    );
    const rawEmail = `  ${runId}-Person@Example.com `;
    const assignment = await replaceAssignment(
      { email: rawEmail, scopeKeys: [scope.key, scope.key], expectedVersion: null },
      primaryActor,
    );
    expect(assignment).toMatchObject({
      email: `${runId}-person@example.com`,
      scopes: [scope.key],
      version: 1,
    });

    await expect(
      replaceAssignment(
        {
          email: rawEmail,
          scopeKeys: [scope.key, `${namespace}:missing`],
          expectedVersion: assignment!.version,
        },
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    await expect(getAssignmentByEmail(rawEmail)).resolves.toMatchObject({
      scopes: [scope.key],
      version: assignment!.version,
    });
  });

  it("rejects stale assignment versions", async () => {
    const email = `${runId}-stale@example.com`;
    const first = await replaceAssignment(
      { email, scopeKeys: ["expenses:read"], expectedVersion: null },
      primaryActor,
    );
    const second = await replaceAssignment(
      {
        email,
        scopeKeys: ["expenses:read", "expenses:create"],
        expectedVersion: first!.version,
      },
      primaryActor,
    );
    await expect(
      replaceAssignment(
        { email, scopeKeys: ["expenses:delete"], expectedVersion: first!.version },
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(getAssignmentByEmail(email)).resolves.toMatchObject({
      scopes: ["expenses:create", "expenses:read"],
      version: second!.version,
    });
  });

  it("lets only one concurrent replacement commit for a version", async () => {
    const email = `${runId}-concurrent@example.com`;
    const current = await replaceAssignment(
      { email, scopeKeys: ["expenses:read"], expectedVersion: null },
      primaryActor,
    );
    const results = await Promise.allSettled([
      replaceAssignment(
        {
          email,
          scopeKeys: ["expenses:create"],
          expectedVersion: current!.version,
        },
        primaryActor,
      ),
      replaceAssignment(
        {
          email,
          scopeKeys: ["expenses:delete"],
          expectedVersion: current!.version,
        },
        primaryActor,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("cascades scope deletion, increments assignment versions, and audits each change", async () => {
    const scope = await createScope(
      { key: `${namespace}:cascade`, description: "Cascade test scope." },
      primaryActor,
    );
    const emails = [`${runId}-cascade-a@example.com`, `${runId}-cascade-b@example.com`];
    const assignments = [];
    for (const email of emails) {
      assignments.push(
        await replaceAssignment(
          { email, scopeKeys: [scope.key, "expenses:read"], expectedVersion: null },
          primaryActor,
        ),
      );
    }

    await expect(
      deleteScope({ id: scope.id, expectedVersion: scope.version }, primaryActor),
    ).resolves.toEqual({ id: scope.id, affectedAssignments: 2 });
    for (const [index, email] of emails.entries()) {
      await expect(getAssignmentByEmail(email)).resolves.toMatchObject({
        scopes: ["expenses:read"],
        version: assignments[index]!.version + 1,
      });
    }
    await expect(
      db.auditEvent.count({
        where: {
          actorId: primaryUserId,
          eventType: "user_scopes.replaced",
          metadata: { path: ["source"], equals: "scope_delete_cascade" },
        },
      }),
    ).resolves.toBeGreaterThanOrEqual(2);
  });

  it("creates, validates, versions, audits, and disables downstream resources without grants", async () => {
    const sharedScope = await createScope(
      { key: `${namespace}:shared`, description: "Shared resource scope." },
      primaryActor,
    );
    const adminScope = await db.scope.findUniqueOrThrow({ where: { key: "weldall:administer" } });
    const origin = `https://${namespace}.example`;
    const grantCountBefore = await db.emailScopeGrant.count();
    const resource = await createResource(
      {
        key: `${namespace}-resource`,
        name: "Admin test resource",
        resourceIdentifier: `${origin}/resource`,
        authorizationServer: origin,
        downstreamClientId: "admin-test-client",
        enabled: true,
        scopeIds: [sharedScope.id],
        requestPrefixes: [`${origin}/api/`, `${origin}/api/events`],
      },
      primaryActor,
    );
    expect(resource).toMatchObject({
      enabled: true,
      version: 1,
      scopeKeys: [sharedScope.key],
      requestPrefixes: [`${origin}/api`, `${origin}/api/events`],
    });
    await expect(db.emailScopeGrant.count()).resolves.toBe(grantCountBefore);

    await expect(
      createResource(
        {
          key: `${namespace}-overlap`,
          name: "Overlapping resource",
          resourceIdentifier: `${origin}/other-resource`,
          authorizationServer: "https://other.example",
          downstreamClientId: "other-client",
          enabled: true,
          scopeIds: [sharedScope.id],
          requestPrefixes: [`${origin}/api/v2`],
        },
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      createResource(
        {
          key: `${namespace}-system`,
          name: "System scope resource",
          resourceIdentifier: "https://system.example/resource",
          authorizationServer: "https://system.example",
          downstreamClientId: "system-client",
          enabled: true,
          scopeIds: [adminScope.id],
          requestPrefixes: ["https://system.example/api"],
        },
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "SYSTEM_SCOPE" });
    await expect(
      createResource(
        {
          key: `${namespace}-unknown`,
          name: "Unknown scope resource",
          resourceIdentifier: "https://unknown.example/resource",
          authorizationServer: "https://unknown.example",
          downstreamClientId: "unknown-client",
          enabled: true,
          scopeIds: ["missing-scope-id"],
          requestPrefixes: ["https://unknown.example/api"],
        },
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    await expect(
      deleteScope({ id: sharedScope.id, expectedVersion: sharedScope.version }, primaryActor),
    ).rejects.toThrow("supported by resource");

    const disabled = await updateResource(
      {
        id: resource.id,
        name: resource.name,
        authorizationServer: resource.authorizationServer,
        downstreamClientId: resource.downstreamClientId,
        enabled: false,
        scopeIds: resource.scopeIds,
        requestPrefixes: resource.requestPrefixes,
        expectedVersion: resource.version,
      },
      primaryActor,
    );
    expect(disabled).toMatchObject({ enabled: false, version: 2 });
    await expect(
      updateResource(
        {
          id: resource.id,
          name: "Stale update",
          authorizationServer: resource.authorizationServer,
          downstreamClientId: resource.downstreamClientId,
          enabled: true,
          scopeIds: resource.scopeIds,
          requestPrefixes: resource.requestPrefixes,
          expectedVersion: resource.version,
        },
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(getResource(resource.id)).resolves.toMatchObject({ enabled: false, version: 2 });
    await expect(
      db.auditEvent.findMany({
        where: { subjectId: resource.id },
        orderBy: { occurredAt: "asc" },
        select: { eventType: true, metadata: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "resource_scopes.created" }),
        expect.objectContaining({ eventType: "resource_scopes.replaced" }),
      ]),
    );
  });

  it("rejects duplicate resource identities and normalized request prefixes", async () => {
    const scope = await db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } });
    const resource = await createResource(resourceInput("identity", scope.id), primaryActor);

    await expect(
      createResource(resourceInput("duplicate-key", scope.id, { key: resource.key }), primaryActor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      createResource(
        resourceInput("duplicate-identifier", scope.id, {
          resourceIdentifier: resource.resourceIdentifier,
        }),
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const duplicateOrigin = `https://${namespace}-duplicate-prefix.example`;
    await expect(
      createResource(
        resourceInput("duplicate-prefix", scope.id, {
          requestPrefixes: [`${duplicateOrigin}/api/`, `${duplicateOrigin}/api`],
        }),
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    await expect(
      createResource(
        resourceInput("encoded-prefix", scope.id, {
          requestPrefixes: [`https://${namespace}-encoded.example/%61pi`],
        }),
        primaryActor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });

  it("lets only one concurrent resource update commit for an expected version", async () => {
    const scope = await db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } });
    const resource = await createResource(
      resourceInput("concurrent-update", scope.id),
      primaryActor,
    );
    const update = (name: string) =>
      updateResource(
        {
          id: resource.id,
          name,
          authorizationServer: resource.authorizationServer,
          downstreamClientId: resource.downstreamClientId,
          enabled: resource.enabled,
          scopeIds: resource.scopeIds,
          requestPrefixes: resource.requestPrefixes,
          expectedVersion: resource.version,
        },
        primaryActor,
      );

    const results = await Promise.allSettled([update("Concurrent A"), update("Concurrent B")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(getResource(resource.id)).resolves.toMatchObject({
      version: resource.version + 1,
    });
  });

  it("serializes concurrent create and update prefix conflicts", async () => {
    const scope = await db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } });
    const createPrefix = `https://${namespace}-create-race.example/api`;
    const creates = await Promise.allSettled([
      createResource(
        resourceInput("create-race-a", scope.id, { requestPrefixes: [createPrefix] }),
        primaryActor,
      ),
      createResource(
        resourceInput("create-race-b", scope.id, { requestPrefixes: [createPrefix] }),
        primaryActor,
      ),
    ]);
    expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(creates.filter((result) => result.status === "rejected")).toHaveLength(1);

    const left = await createResource(resourceInput("update-race-a", scope.id), primaryActor);
    const right = await createResource(resourceInput("update-race-b", scope.id), primaryActor);
    const updatePrefix = `https://${namespace}-update-race.example/api`;
    const update = (resource: Awaited<ReturnType<typeof createResource>>) =>
      updateResource(
        {
          id: resource.id,
          name: resource.name,
          authorizationServer: resource.authorizationServer,
          downstreamClientId: resource.downstreamClientId,
          enabled: resource.enabled,
          scopeIds: resource.scopeIds,
          requestPrefixes: [updatePrefix],
          expectedVersion: resource.version,
        },
        primaryActor,
      );
    const updates = await Promise.allSettled([update(left), update(right)]);
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("updates the CLI appendix with optimistic locking and an audit event", async () => {
    const initial = await getCliSettings();
    const appendix = `Gude from ${runId}. Use this for everything related to Seibert.`;
    const updated = await updateCliSettings(
      { appendix, expectedVersion: initial.version },
      primaryActor,
    );
    expect(updated).toMatchObject({ appendix, version: initial.version + 1 });
    await expect(
      updateCliSettings({ appendix: "stale", expectedVersion: initial.version }, primaryActor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.auditEvent.count({
        where: { actorId: primaryUserId, eventType: "cli_settings.updated" },
      }),
    ).resolves.toBeGreaterThanOrEqual(1);
    await updateCliSettings(
      { appendix: initial.appendix, expectedVersion: updated.version },
      primaryActor,
    );
  });

  it("creates, filters, updates, renders, and deletes skills", async () => {
    const publicSkill = await createSkill(
      {
        slug: `${namespace}.public`,
        title: "Public test skill",
        content: "Use `weldall request --scope expenses:read https://example.com/data`.",
        requiredScopes: ["expenses:read"],
        hidden: false,
      },
      primaryActor,
    );
    const hiddenSkill = await createSkill(
      {
        slug: `${namespace}.hidden`,
        title: "Hidden test skill",
        content: "Hidden instructions.",
        requiredScopes: ["expenses:read"],
        hidden: true,
      },
      primaryActor,
    );

    await expect(listSkills({ page: 1, pageSize: 20, q: namespace })).resolves.toMatchObject({
      total: 2,
    });
    const initiallyVisible = await listVisibleSkills(primaryEmail);
    expect(initiallyVisible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: publicSkill.slug, available: false }),
      ]),
    );
    expect(initiallyVisible.some((skill) => skill.slug === hiddenSkill.slug)).toBe(false);

    const assignment = await getAssignmentByEmail(primaryEmail);
    const withRead = await replaceAssignment(
      {
        email: primaryEmail,
        scopeKeys: ["weldall:administer", "expenses:read"],
        expectedVersion: assignment!.version,
      },
      primaryActor,
    );
    await expect(getVisibleSkill(primaryEmail, hiddenSkill.slug)).resolves.toMatchObject({
      slug: hiddenSkill.slug,
      available: true,
      document: expect.stringContaining("requiredScopes:"),
    });

    const updated = await updateSkill(
      {
        id: publicSkill.id,
        title: "Updated public skill",
        content: publicSkill.content,
        requiredScopes: [],
        hidden: true,
        expectedVersion: publicSkill.version,
      },
      primaryActor,
    );
    expect(updated).toMatchObject({ title: "Updated public skill", version: 2 });
    await expect(
      deleteSkill({ id: updated.id, expectedVersion: publicSkill.version }, primaryActor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await deleteSkill({ id: updated.id, expectedVersion: updated.version }, primaryActor);
    await deleteSkill({ id: hiddenSkill.id, expectedVersion: hiddenSkill.version }, primaryActor);
    await replaceAssignment(
      {
        email: primaryEmail,
        scopeKeys: ["weldall:administer"],
        expectedVersion: withRead!.version,
      },
      primaryActor,
    );
  });

  it("blocks deleting scopes that are still referenced by skills", async () => {
    const scope = await createScope(
      { key: `${namespace}:skillref`, description: "Skill reference scope." },
      primaryActor,
    );
    const skill = await createSkill(
      {
        slug: `${namespace}.scope-reference`,
        title: "Scope reference",
        content: "Referenced scope instructions.",
        requiredScopes: [scope.key],
        hidden: true,
      },
      primaryActor,
    );
    await expect(
      deleteScope({ id: scope.id, expectedVersion: scope.version }, primaryActor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await deleteSkill({ id: skill.id, expectedVersion: skill.version }, primaryActor);
    await expect(
      deleteScope({ id: scope.id, expectedVersion: scope.version }, primaryActor),
    ).resolves.toMatchObject({ id: scope.id });
  });

  it("protects the built-in administrator scope", async () => {
    const adminScope = await db.scope.findUniqueOrThrow({
      where: { key: "weldall:administer" },
    });
    await expect(
      deleteScope({ id: adminScope.id, expectedVersion: adminScope.version }, primaryActor),
    ).rejects.toMatchObject({ code: "SYSTEM_SCOPE" });
  });

  it("protects the last administrator and allows an explicit handover", async () => {
    expect(countVerifiedAdminEmails([primaryEmail, "pending@example.com"], [primaryEmail])).toBe(1);
    expect(() => assertAdminCanBeRemoved(1)).toThrow("last administrator");
    expect(() => assertAdminCanBeRemoved(2)).not.toThrow();

    const primary = await getAssignmentByEmail(primaryEmail);
    const secondary = await replaceAssignment(
      { email: secondaryEmail, scopeKeys: ["weldall:administer"], expectedVersion: null },
      primaryActor,
    );
    const removedPrimary = await replaceAssignment(
      { email: primaryEmail, scopeKeys: [], expectedVersion: primary!.version },
      primaryActor,
    );
    expect(removedPrimary?.scopes).toEqual([]);

    const restoredPrimary = await replaceAssignment(
      {
        email: primaryEmail,
        scopeKeys: ["weldall:administer"],
        expectedVersion: removedPrimary!.version,
      },
      secondaryActor,
    );
    await replaceAssignment(
      { email: secondaryEmail, scopeKeys: [], expectedVersion: secondary!.version },
      primaryActor,
    );
    expect(restoredPrimary?.scopes).toContain("weldall:administer");
  });

  it("keeps one admin when two verified admins remove themselves concurrently", async () => {
    const activeAdminAssignments = await db.emailScopeAssignment.findMany({
      where: { grants: { some: { scope: { key: "weldall:administer" } } } },
      select: { normalizedEmail: true },
    });
    const verifiedUsers = await db.user.findMany({
      where: { emailVerified: true },
      select: { email: true },
    });
    const activeAdminCount = countVerifiedAdminEmails(
      activeAdminAssignments.map((assignment) => assignment.normalizedEmail),
      verifiedUsers.map((user) => user.email),
    );
    expect(activeAdminCount).toBeGreaterThanOrEqual(1);
    if (activeAdminCount !== 1) return;

    const primary = await getAssignmentByEmail(primaryEmail);
    const previousSecondary = await getAssignmentByEmail(secondaryEmail);
    const secondary = await replaceAssignment(
      {
        email: secondaryEmail,
        scopeKeys: ["weldall:administer"],
        expectedVersion: previousSecondary?.version ?? null,
      },
      primaryActor,
    );
    const results = await Promise.allSettled([
      replaceAssignment(
        { email: primaryEmail, scopeKeys: [], expectedVersion: primary!.version },
        primaryActor,
      ),
      replaceAssignment(
        { email: secondaryEmail, scopeKeys: [], expectedVersion: secondary!.version },
        secondaryActor,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    let primaryAfter = await getAssignmentByEmail(primaryEmail);
    let secondaryAfter = await getAssignmentByEmail(secondaryEmail);
    if (!primaryAfter?.scopes.includes("weldall:administer")) {
      primaryAfter = await replaceAssignment(
        {
          email: primaryEmail,
          scopeKeys: ["weldall:administer"],
          expectedVersion: primaryAfter!.version,
        },
        secondaryActor,
      );
    }
    if (secondaryAfter?.scopes.includes("weldall:administer")) {
      secondaryAfter = await replaceAssignment(
        {
          email: secondaryEmail,
          scopeKeys: [],
          expectedVersion: secondaryAfter.version,
        },
        primaryActor,
      );
    }
    expect(primaryAfter?.scopes).toContain("weldall:administer");
    expect(secondaryAfter?.scopes).toEqual([]);
  });
});
