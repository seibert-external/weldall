import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import {
  assertAdminCanBeRemoved,
  countVerifiedAdminEmails,
  createScope,
  createSkill,
  deleteScope,
  deleteSkill,
  getAssignmentByEmail,
  getCliSettings,
  listSkills,
  replaceAssignment,
  updateCliSettings,
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
  await db.scope.deleteMany({ where: { key: { startsWith: namespace } } });
  await db.skill.deleteMany({ where: { slug: { startsWith: namespace } } });
  await db.adminAuditEvent.deleteMany({
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
      db.adminAuditEvent.count({
        where: {
          actorId: primaryUserId,
          eventType: "user_scopes.replaced",
          metadata: { path: ["source"], equals: "scope_delete_cascade" },
        },
      }),
    ).resolves.toBeGreaterThanOrEqual(2);
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
      db.adminAuditEvent.count({
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
