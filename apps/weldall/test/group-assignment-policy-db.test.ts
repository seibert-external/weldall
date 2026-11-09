import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import {
  mutateGroupAssignment,
  mutateScope,
  type MutationActor,
} from "../src/server/domain/primitive-mutations";

const prefix = `gapolicy-${randomUUID().replaceAll("-", "")}`;
const actor: MutationActor = {
  type: "machine",
  id: `${prefix}-runner`,
  requestId: `${prefix}-request`,
  source: "weldall_up",
};
const readScope = `${prefix}:read`;
const writeScope = `${prefix}:write`;
let providerKey: string;

beforeAll(async () => {
  const provider = await db.groupProvider.create({
    data: {
      key: `${prefix}-provider`,
      name: "Policy provider",
      adapterType: "management-api-v1",
      baseUrl: "https://unavailable.invalid",
      encryptedToken: "not-used",
      encryptionKeyVersion: 1,
      enabled: false,
      createdBy: actor.id,
      updatedBy: actor.id,
    },
  });
  providerKey = provider.key;
  await db.$transaction(async (tx) => {
    for (const key of [readScope, writeScope])
      await mutateScope({ tx, input: { action: "create", key, description: key }, actor });
  });
});

afterAll(async () => {
  await db.groupScopeAssignment.deleteMany({ where: { provider: { key: { startsWith: prefix } } } });
  await db.groupProvider.deleteMany({ where: { key: { startsWith: prefix } } });
  await db.auditEvent.deleteMany({ where: { actorId: { startsWith: prefix } } });
  await db.scope.deleteMany({ where: { key: { startsWith: prefix } } });
});

const create = (groupId: string, policy?: { version: 1; shell?: boolean }) =>
  db.$transaction((tx) =>
    mutateGroupAssignment(
      tx,
      { action: "create", providerKey, groupId, scopeKeys: [readScope], policy },
      actor,
    ),
  );

const update = (id: string, expectedVersion: number, scopeKeys: string[], policy?: unknown) =>
  db.$transaction((tx) =>
    mutateGroupAssignment(
      tx,
      { action: "update", id, expectedVersion, scopeKeys, policy: policy as never },
      actor,
    ),
  );

describe("group assignment client policy", () => {
  it("stores a policy on create and returns it", async () => {
    const saved = await create("create", { version: 1, shell: true });
    expect(saved.policy).toEqual({ version: 1, shell: true });
  });

  it("updates only the policy when the scopes are unchanged", async () => {
    const saved = await create("policy-only", { version: 1, shell: false });
    const updated = await update(saved.id, saved.version, [readScope], {
      version: 1,
      approvalMode: "auto",
    });
    expect(updated.policy).toEqual({ version: 1, approvalMode: "auto" });
    expect(updated.version).toBe(saved.version + 1);
  });

  it("keeps the policy when an update leaves it out", async () => {
    const saved = await create("keep", { version: 1, shell: true });
    const updated = await update(saved.id, saved.version, [readScope, writeScope]);
    expect(updated.policy).toEqual({ version: 1, shell: true });
    expect(updated.grants.map(({ scope }: any) => scope.key).sort()).toEqual(
      [readScope, writeScope].sort(),
    );
  });

  it("clears the policy with null", async () => {
    const saved = await create("clear", { version: 1, shell: true });
    const updated = await update(saved.id, saved.version, [readScope], null);
    expect(updated.policy).toBeNull();
  });

  it("rejects an invalid policy", async () => {
    const saved = await create("invalid");
    await expect(
      update(saved.id, saved.version, [readScope], { version: 1, approvalMode: "yolo" }),
    ).rejects.toThrow();
  });
});
