import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { createScope, deleteScope, type AdminActor } from "../src/server/admin/service.js";
import {
  createGroupAssignments,
  createGroupProvider,
  deleteGroupAssignment,
  deleteGroupProvider,
  getGroupAssignment,
  listAssignedProviderGroupIds,
  replaceGroupAssignment,
  testGroupProvider,
  updateGroupProvider,
} from "../src/server/group-providers/service.js";
import { effectiveScopesFor, exchangePolicyFor } from "../src/server/policy/resources.js";

const runId = randomUUID().replaceAll("-", "");
const email = `group-policy-${runId}@example.com`;
const providerKey = `provider-${runId}`;
const actor: AdminActor = {
  id: `group-policy-actor-${runId}`,
  email: `actor-${runId}@example.com`,
  requestId: `group-policy-${runId}`,
};
let memberGroups = ["finance"];
let malformedUserDetail = false;
let lookupCount = 0;
let groupListLookupCount = 0;
let userDetailGate: Promise<void> | null = null;
let userDetailStarted: (() => void) | null = null;

beforeAll(async () => {
  process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/management/groups/")) {
      groupListLookupCount += 1;
      return json([
        { ou: "finance", cn: "Finance", unrelated: "ignored" },
        { ou: "other", cn: "Other" },
      ]);
    }
    if (url.includes("/api/management/users/?mail=")) {
      lookupCount += 1;
      return json([{ username: "alice", email, is_active: true, extra: "ignored" }]);
    }
    if (url.endsWith("/api/management/users/alice/")) {
      userDetailStarted?.();
      if (userDetailGate) await userDetailGate;
      return malformedUserDetail
        ? json({ username: "alice", email, is_active: true })
        : json({ username: "alice", email, is_active: true, groups: memberGroups });
    }
    return new Response(null, { status: 404, headers: { "content-type": "application/json" } });
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.groupScopeAssignment.deleteMany({
    where: { provider: { key: { startsWith: providerKey } } },
  });
  await db.groupProvider.deleteMany({ where: { key: { startsWith: providerKey } } });
  await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: email } });
  await db.auditEvent.deleteMany({ where: { actorId: actor.id } });
});

describe("group provider administration and effective policy", () => {
  it("creates opaque group-ID assignments and unions live memberships with direct grants", async () => {
    await expect(
      testGroupProvider(
        {
          key: `configuration-${runId}`,
          adapterType: "management-api-v1",
          baseUrl: "https://provider.example",
          token: "configuration-token",
        },
        actor,
      ),
    ).resolves.toMatchObject({ status: "ok", groupCount: 2 });
    const configurationAudit = await db.auditEvent.findFirstOrThrow({
      where: { actorId: actor.id, eventType: "group_provider.tested" },
      orderBy: { occurredAt: "desc" },
    });
    expect(configurationAudit.metadata).toMatchObject({ persisted: false, version: 0 });

    const read = await db.scope.findUniqueOrThrow({ where: { key: "expenses:read" } });
    const direct = await db.emailScopeAssignment.create({
      data: {
        normalizedEmail: email,
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: { create: { scopeId: read.id, createdBy: actor.id } },
      },
    });
    expect(direct.id).toBeTruthy();

    let provider = await createGroupProvider(
      {
        key: providerKey,
        name: "Policy provider",
        adapterType: "management-api-v1",
        baseUrl: "https://provider.example/",
        token: "write-only-provider-token",
        enabled: true,
      },
      actor,
    );
    expect(provider).toMatchObject({ hasToken: true, baseUrl: "https://provider.example" });
    expect(JSON.stringify(provider)).not.toContain("write-only-provider-token");
    const encryptedBefore = await db.groupProvider.findUniqueOrThrow({
      where: { id: provider.id },
      select: { encryptedToken: true },
    });
    await expect(
      updateGroupProvider(
        {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          enabled: true,
          expectedVersion: provider.version + 10,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    provider = await updateGroupProvider(
      {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        token: "replacement-token",
        enabled: true,
        expectedVersion: provider.version,
      },
      actor,
    );
    const encryptedAfter = await db.groupProvider.findUniqueOrThrow({
      where: { id: provider.id },
      select: { encryptedToken: true },
    });
    expect(encryptedAfter.encryptedToken).not.toBe(encryptedBefore.encryptedToken);
    expect(JSON.stringify(provider)).not.toContain("replacement-token");

    const groupListsBeforeAssignment = groupListLookupCount;
    let [assignment] = await createGroupAssignments(
      {
        providerId: provider.id,
        groupIds: ["finance"],
        scopeKeys: ["expenses:create", "expenses:create", "weldall:administer", "weldall:login"],
      },
      actor,
    );
    expect(assignment).toMatchObject({
      groupId: "finance",
      scopes: ["expenses:create", "weldall:administer", "weldall:login"],
    });
    expect(assignment).not.toHaveProperty("groupName");
    expect(groupListLookupCount).toBe(groupListsBeforeAssignment);
    const createdAudit = await db.auditEvent.findFirstOrThrow({
      where: { subjectId: assignment!.id, eventType: "group_scopes.created" },
    });
    expect(createdAudit.metadata).toMatchObject({
      afterScopes: ["expenses:create", "weldall:administer", "weldall:login"],
      addedScopes: ["expenses:create", "weldall:administer", "weldall:login"],
    });
    assignment = await replaceGroupAssignment(
      {
        id: assignment!.id,
        scopeKeys: ["expenses:create", "expenses:delete", "weldall:administer", "weldall:login"],
        expectedVersion: assignment!.version,
      },
      actor,
    );
    expect(assignment).toMatchObject({
      version: 2,
      scopes: ["expenses:create", "expenses:delete", "weldall:administer", "weldall:login"],
    });
    const replacedAudit = await db.auditEvent.findFirstOrThrow({
      where: { subjectId: assignment.id, eventType: "group_scopes.replaced" },
    });
    expect(replacedAudit.metadata).toMatchObject({
      addedScopes: ["expenses:delete"],
      removedScopes: [],
      versionBefore: 1,
      versionAfter: 2,
    });
    await expect(getGroupAssignment(assignment.id)).resolves.toMatchObject({
      id: assignment.id,
      providerId: provider.id,
      groupId: "finance",
      scopes: ["expenses:create", "expenses:delete", "weldall:administer", "weldall:login"],
    });
    await expect(getGroupAssignment("missing-assignment")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(listAssignedProviderGroupIds(provider.id)).resolves.toEqual(["finance"]);
    await expect(
      deleteGroupProvider({ id: provider.id, expectedVersion: provider.version }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const temporaryScope = await createScope(
      { key: `gp-${runId}:temp`, description: "Temporary group scope." },
      actor,
    );
    const [temporaryAssignment] = await createGroupAssignments(
      {
        providerId: provider.id,
        groupIds: ["other"],
        scopeKeys: [temporaryScope.key],
      },
      actor,
    );
    await expect(
      deleteScope({ id: temporaryScope.id, expectedVersion: temporaryScope.version }, actor),
    ).resolves.toMatchObject({ affectedAssignments: 1 });
    const versionedAssignment = await db.groupScopeAssignment.findUniqueOrThrow({
      where: { id: temporaryAssignment!.id },
      include: { grants: true },
    });
    expect(versionedAssignment).toMatchObject({ version: 2, grants: [] });
    await deleteGroupAssignment(
      { id: temporaryAssignment!.id, expectedVersion: versionedAssignment.version },
      actor,
    );

    const beforeLookups = lookupCount;
    await expect(effectiveScopesFor(email)).resolves.toEqual([
      "expenses:create",
      "expenses:delete",
      "expenses:read",
      "weldall:administer",
      "weldall:login",
    ]);
    await expect(effectiveScopesFor(email)).resolves.toEqual([
      "expenses:create",
      "expenses:delete",
      "expenses:read",
      "weldall:administer",
      "weldall:login",
    ]);
    expect(lookupCount - beforeLookups).toBe(2);

    let releaseUserDetail!: () => void;
    userDetailGate = new Promise<void>((resolve) => {
      releaseUserDetail = resolve;
    });
    const userDetailWasRequested = new Promise<void>((resolve) => {
      userDetailStarted = resolve;
    });
    const lookupDuringDisable = effectiveScopesFor(email);
    await userDetailWasRequested;
    provider = await updateGroupProvider(
      {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled: false,
        expectedVersion: provider.version,
      },
      actor,
    );
    releaseUserDetail();
    await expect(lookupDuringDisable).resolves.toEqual(["expenses:read"]);
    userDetailGate = null;
    userDetailStarted = null;
    provider = await updateGroupProvider(
      {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled: true,
        expectedVersion: provider.version,
      },
      actor,
    );

    memberGroups = [];
    await expect(effectiveScopesFor(email)).resolves.toEqual(["expenses:read"]);
    malformedUserDetail = true;
    memberGroups = ["finance"];
    await expect(effectiveScopesFor(email)).resolves.toEqual(["expenses:read"]);
    malformedUserDetail = false;

    const policy = await exchangePolicyFor({
      email,
      resourceIdentifier: "https://expenses.seibert.localdev/api",
      authorizationServer: "https://expenses.seibert.localdev",
    });
    expect(policy?.grantedScopes).toEqual(
      expect.arrayContaining(["expenses:create", "expenses:read"]),
    );

    const disabled = await updateGroupProvider(
      {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled: false,
        expectedVersion: provider.version,
      },
      actor,
    );
    await expect(effectiveScopesFor(email)).resolves.toEqual(["expenses:read"]);

    await deleteGroupAssignment({ id: assignment.id, expectedVersion: assignment.version }, actor);
    await deleteGroupProvider({ id: provider.id, expectedVersion: disabled.version }, actor);
  });

  it("stages arbitrary group IDs for disabled providers without a provider request", async () => {
    const provider = await createGroupProvider(
      {
        key: `${providerKey}-disabled`,
        name: "Disabled staging provider",
        adapterType: "management-api-v1",
        baseUrl: "https://unavailable.invalid",
        token: "unused-token",
        enabled: false,
      },
      actor,
    );
    const groupListsBeforeAssignment = groupListLookupCount;
    const [assignment] = await createGroupAssignments(
      {
        providerId: provider.id,
        groupIds: ["future:team/id"],
        scopeKeys: ["expenses:read"],
      },
      actor,
    );

    expect(assignment).toMatchObject({
      providerId: provider.id,
      groupId: "future:team/id",
      scopes: ["expenses:read"],
    });
    expect(groupListLookupCount).toBe(groupListsBeforeAssignment);

    await deleteGroupAssignment(
      { id: assignment!.id, expectedVersion: assignment!.version },
      actor,
    );
    await deleteGroupProvider({ id: provider.id, expectedVersion: provider.version }, actor);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
