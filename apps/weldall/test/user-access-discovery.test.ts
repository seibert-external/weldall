import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { getUser, listUsers, type AdminActor } from "../src/server/admin/service.js";
import { createGroupProvider } from "../src/server/group-providers/service.js";

const runId = randomUUID().replaceAll("-", "");
const namespace = `useraccess${runId}`;
const assignedUserId = `${namespace}-assigned`;
const assignedEmail = `${namespace}-assigned@example.com`;
const unassignedUserId = `${namespace}-unassigned`;
const unassignedEmail = `${namespace}-unassigned@example.com`;
const actor: AdminActor = {
  id: `${namespace}-actor`,
  email: `${namespace}-actor@example.com`,
  requestId: `${namespace}-request`,
};
let providerUnavailable = false;
let directAssignmentId: string;
let alphaGroupAssignmentId: string;
let zuluGroupAssignmentId: string;

beforeAll(async () => {
  process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    if (providerUnavailable) return new Response(null, { status: 503 });
    const url = String(input);
    if (url.includes("/api/management/users/?mail=")) {
      return Response.json(
        url.includes(encodeURIComponent(assignedEmail))
          ? [{ username: "known-person", email: assignedEmail, is_active: true }]
          : [],
      );
    }
    if (url.endsWith("/api/management/users/known-person/")) {
      return Response.json({
        username: "known-person",
        email: assignedEmail,
        is_active: true,
        groups: ["team-zulu", "team-alpha", "team-alpha"],
      });
    }
    return new Response(null, { status: 404 });
  });

  await db.user.createMany({
    data: [
      {
        id: assignedUserId,
        name: "Assigned Person",
        email: assignedEmail,
        emailVerified: true,
      },
      {
        id: unassignedUserId,
        name: "Unassigned Person",
        email: unassignedEmail,
        emailVerified: true,
      },
    ],
  });
  const [alphaScope, groupOnlyScope, zuluScope] = await Promise.all([
    db.scope.create({
      data: {
        id: `${namespace}-scope-alpha`,
        key: `${namespace}:alpha`,
        description: "Alpha access.",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    }),
    db.scope.create({
      data: {
        id: `${namespace}-scope-group-only`,
        key: `${namespace}:group-only`,
        description: "Group-only access.",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    }),
    db.scope.create({
      data: {
        id: `${namespace}-scope-zulu`,
        key: `${namespace}:zulu`,
        description: "Zulu access.",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    }),
  ]);

  const directAssignment = await db.emailScopeAssignment.create({
    data: {
      normalizedEmail: assignedEmail,
      createdBy: actor.id,
      updatedBy: actor.id,
      grants: {
        create: [
          { id: randomUUID(), scopeId: zuluScope.id, createdBy: actor.id },
          { id: randomUUID(), scopeId: alphaScope.id, createdBy: actor.id },
        ],
      },
    },
  });
  directAssignmentId = directAssignment.id;

  const provider = await createGroupProvider(
    {
      key: `${namespace}-provider`,
      name: "Discovery groups",
      adapterType: "management-api-v1",
      baseUrl: "https://user-access-provider.example",
      token: "test-token-that-is-never-returned",
      enabled: true,
    },
    actor,
  );
  const [zuluGroupAssignment, alphaGroupAssignment] = await Promise.all([
    db.groupScopeAssignment.create({
      data: {
        providerId: provider.id,
        groupId: "team-zulu",
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: { create: { id: randomUUID(), scopeId: alphaScope.id, createdBy: actor.id } },
      },
    }),
    db.groupScopeAssignment.create({
      data: {
        providerId: provider.id,
        groupId: "team-alpha",
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: {
          create: [
            { id: randomUUID(), scopeId: alphaScope.id, createdBy: actor.id },
            { id: randomUUID(), scopeId: groupOnlyScope.id, createdBy: actor.id },
          ],
        },
      },
    }),
  ]);
  zuluGroupAssignmentId = zuluGroupAssignment.id;
  alphaGroupAssignmentId = alphaGroupAssignment.id;

  const [zuluResource, alphaResource, groupOnlyResource] = await Promise.all([
    db.downstreamResource.create({
      data: {
        id: `${namespace}-resource-zulu`,
        key: `${namespace}-resource-zulu`,
        name: "Zulu resource",
        resourceIdentifier: `https://${namespace}-zulu.example/api`,
        authorizationServer: `https://${namespace}-zulu.example`,
        downstreamClientId: `${namespace}-zulu-client`,
        enabled: true,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    }),
    db.downstreamResource.create({
      data: {
        id: `${namespace}-resource-alpha`,
        key: `${namespace}-resource-alpha`,
        name: "Alpha resource",
        resourceIdentifier: `https://${namespace}-alpha.example/api`,
        authorizationServer: `https://${namespace}-alpha.example`,
        downstreamClientId: `${namespace}-alpha-client`,
        enabled: true,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    }),
    db.downstreamResource.create({
      data: {
        id: `${namespace}-resource-group-only`,
        key: `${namespace}-resource-group-only`,
        name: "Group-only resource",
        resourceIdentifier: `https://${namespace}-group-only.example/api`,
        authorizationServer: `https://${namespace}-group-only.example`,
        downstreamClientId: `${namespace}-group-only-client`,
        enabled: true,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    }),
  ]);
  await db.resourceScope.createMany({
    data: [
      { resourceId: zuluResource.id, scopeId: zuluScope.id },
      { resourceId: alphaResource.id, scopeId: zuluScope.id },
      { resourceId: alphaResource.id, scopeId: alphaScope.id },
      { resourceId: groupOnlyResource.id, scopeId: groupOnlyScope.id },
    ],
  });
  await db.skill.createMany({
    data: [
      {
        id: `${namespace}-skill-zulu`,
        slug: `${namespace}.zulu`,
        title: "Zulu skill",
        content: "# Zulu",
        requiredScopes: [zuluScope.key],
        createdBy: actor.id,
        updatedBy: actor.id,
      },
      {
        id: `${namespace}-skill-alpha`,
        slug: `${namespace}.alpha`,
        title: "Alpha skill",
        content: "# Alpha",
        requiredScopes: [zuluScope.key, alphaScope.key, alphaScope.key],
        createdBy: actor.id,
        updatedBy: actor.id,
      },
      {
        id: `${namespace}-skill-group-only`,
        slug: `${namespace}.group-only`,
        title: "Group-only skill",
        content: "# Group-only",
        requiredScopes: [groupOnlyScope.key],
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    ],
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.groupScopeAssignment.deleteMany({
    where: { provider: { key: `${namespace}-provider` } },
  });
  await db.groupProvider.deleteMany({ where: { key: `${namespace}-provider` } });
  await db.emailScopeAssignment.deleteMany({
    where: { normalizedEmail: { in: [assignedEmail, unassignedEmail] } },
  });
  await db.skill.deleteMany({ where: { slug: { startsWith: namespace } } });
  await db.downstreamResource.deleteMany({ where: { key: { startsWith: namespace } } });
  await db.scope.deleteMany({ where: { key: { startsWith: `${namespace}:` } } });
  await db.user.deleteMany({ where: { id: { in: [assignedUserId, unassignedUserId] } } });
});

describe("user access discovery", () => {
  it("returns a server-known person even when no assignment exists", async () => {
    const listing = await listUsers({
      page: 1,
      pageSize: 20,
      q: unassignedEmail,
      sort: "email.asc",
    });
    const user = await getUser(unassignedUserId);

    expect(listing).toMatchObject({
      total: 1,
      items: [{ id: unassignedUserId, email: unassignedEmail }],
    });
    expect(user).toMatchObject({
      id: unassignedUserId,
      email: unassignedEmail,
      access: {
        effectiveScopes: [],
        resources: [],
        unavailableGroupProviders: [],
      },
    });
    expect(user.access.skills.filter((skill) => skill.slug.startsWith(namespace))).toEqual([]);
  });

  it("shows resources, skills, and every assignment behind effective scopes deterministically", async () => {
    const first = await getUser(assignedUserId);
    const second = await getUser(assignedUserId);

    expect(second.access).toEqual(first.access);
    expect(first.access.effectiveScopes).toEqual([
      {
        key: `${namespace}:alpha`,
        assignments: [
          { type: "email", id: directAssignmentId, email: assignedEmail },
          {
            type: "group",
            id: alphaGroupAssignmentId,
            providerId: expect.any(String),
            providerKey: `${namespace}-provider`,
            providerName: "Discovery groups",
            groupId: "team-alpha",
          },
          {
            type: "group",
            id: zuluGroupAssignmentId,
            providerId: expect.any(String),
            providerKey: `${namespace}-provider`,
            providerName: "Discovery groups",
            groupId: "team-zulu",
          },
        ],
      },
      {
        key: `${namespace}:group-only`,
        assignments: [
          {
            type: "group",
            id: alphaGroupAssignmentId,
            providerId: expect.any(String),
            providerKey: `${namespace}-provider`,
            providerName: "Discovery groups",
            groupId: "team-alpha",
          },
        ],
      },
      {
        key: `${namespace}:zulu`,
        assignments: [{ type: "email", id: directAssignmentId, email: assignedEmail }],
      },
    ]);
    expect(first.access.resources).toEqual([
      {
        id: `${namespace}-resource-alpha`,
        key: `${namespace}-resource-alpha`,
        name: "Alpha resource",
        grantedScopes: [`${namespace}:alpha`, `${namespace}:zulu`],
      },
      {
        id: `${namespace}-resource-group-only`,
        key: `${namespace}-resource-group-only`,
        name: "Group-only resource",
        grantedScopes: [`${namespace}:group-only`],
      },
      {
        id: `${namespace}-resource-zulu`,
        key: `${namespace}-resource-zulu`,
        name: "Zulu resource",
        grantedScopes: [`${namespace}:zulu`],
      },
    ]);
    expect(first.access.skills.filter((skill) => skill.slug.startsWith(namespace))).toEqual([
      {
        slug: `${namespace}.alpha`,
        title: "Alpha skill",
        requiredScopes: [`${namespace}:alpha`, `${namespace}:zulu`],
        source: { type: "admin" },
      },
      {
        slug: `${namespace}.group-only`,
        title: "Group-only skill",
        requiredScopes: [`${namespace}:group-only`],
        source: { type: "admin" },
      },
      {
        slug: `${namespace}.zulu`,
        title: "Zulu skill",
        requiredScopes: [`${namespace}:zulu`],
        source: { type: "admin" },
      },
    ]);
    expect(JSON.stringify(first.access)).not.toContain("test-token-that-is-never-returned");
  });

  it("fails group-derived discovery closed and reports the incomplete provider lookup", async () => {
    providerUnavailable = true;
    const user = await getUser(assignedUserId);
    providerUnavailable = false;

    expect(user.access.effectiveScopes).toEqual([
      {
        key: `${namespace}:alpha`,
        assignments: [{ type: "email", id: directAssignmentId, email: assignedEmail }],
      },
      {
        key: `${namespace}:zulu`,
        assignments: [{ type: "email", id: directAssignmentId, email: assignedEmail }],
      },
    ]);
    expect(user.access.resources.map((resource) => resource.key)).not.toContain(
      `${namespace}-resource-group-only`,
    );
    expect(user.access.skills.map((skill) => skill.slug)).not.toContain(`${namespace}.group-only`);
    expect(user.access.unavailableGroupProviders).toEqual([
      {
        id: expect.any(String),
        key: `${namespace}-provider`,
        name: "Discovery groups",
      },
    ]);
  });
});
