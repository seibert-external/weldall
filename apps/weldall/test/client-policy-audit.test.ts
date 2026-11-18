import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, IAC_SCOPE_KEY } from "@weldall/db";
import { calculateJwkThumbprint } from "jose";
import { generateEs256KeyPair } from "@weldall/sdk";
import { parseDesiredState } from "../src/server/iac/contracts";
import { applyIac, planIac, type IacActor } from "../src/server/iac/service";
import { prismaAuditWriter } from "../src/server/audit/service";
import { replaceGroupAssignment } from "../src/server/group-providers/service";

const runId = randomUUID().replaceAll("-", "");
const prefix = `cpaudit-${runId}`;
let runner: Omit<IacActor, "requestId">;
let providerKey: string;
let originalCli: { logoUrl: string; policy: unknown } | undefined;

beforeAll(async () => {
  const iacScope = await db.scope.findUniqueOrThrow({ where: { key: IAC_SCOPE_KEY } });
  const keys = await generateEs256KeyPair();
  const thumbprint = await calculateJwkThumbprint(keys.publicJwk, "sha256");
  const clientId = `${prefix}-runner`;
  await db.machineClient.create({
    data: {
      clientId,
      name: "Policy audit runner",
      createdBy: clientId,
      updatedBy: clientId,
      keys: {
        create: { kid: "current", publicJwk: keys.publicJwk, thumbprint, createdBy: clientId },
      },
      allowedScopes: { create: { scopeId: iacScope.id } },
    },
  });
  runner = { clientId, keyId: "current", keyThumbprint: thumbprint };
  const provider = await db.groupProvider.create({
    data: {
      key: `${prefix}-provider`,
      name: "Policy audit provider",
      adapterType: "management-api-v1",
      baseUrl: "https://unavailable.invalid",
      encryptedToken: "not-used",
      encryptionKeyVersion: 1,
      enabled: false,
      createdBy: clientId,
      updatedBy: clientId,
    },
  });
  providerKey = provider.key;
  const cli = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
  originalCli = { logoUrl: cli.logoUrl, policy: cli.policy };
});

afterAll(async () => {
  if (originalCli)
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: originalCli.logoUrl, policy: (originalCli.policy ?? undefined) as never },
    });
  await db.iacOperation.deleteMany({ where: { workspace: { name: { startsWith: prefix } } } });
  await db.iacObjectBinding.deleteMany({ where: { workspace: { name: { startsWith: prefix } } } });
  await db.iacWorkspace.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.groupScopeAssignment.deleteMany({
    where: { provider: { key: { startsWith: prefix } } },
  });
  await db.groupProvider.deleteMany({ where: { key: { startsWith: prefix } } });
  await db.auditEvent.deleteMany({
    where: { OR: [{ actorId: { startsWith: prefix } }, { requestId: { startsWith: prefix } }] },
  });
  await db.machineAllowedScope.deleteMany({
    where: { client: { clientId: { startsWith: prefix } } },
  });
  await db.machineClient.deleteMany({ where: { clientId: { startsWith: prefix } } });
  await db.scope.deleteMany({ where: { key: { startsWith: prefix } } });
});

const workspace = (name: string) => ({
  id: randomUUID(),
  name: `${prefix}-${name}`,
  issuer: "https://weldall.example.com",
});

/** Applies a manifest through the IaC path and returns the request ID it ran under. */
async function apply(target: ReturnType<typeof workspace>, document: Record<string, unknown>) {
  const requestId = `${prefix}-${randomUUID()}`;
  const manifest = parseDesiredState({
    apiVersion: "weldall.dev/v1",
    workspace: target,
    scopes: {
      a: { key: `${target.name}:a`, description: "A" },
      b: { key: `${target.name}:b`, description: "B" },
    },
    ...document,
  });
  const plan = await planIac(manifest);
  await applyIac(
    {
      manifest,
      plannedRevision: plan.revision,
      configDigest: plan.configDigest,
      planDigest: plan.digest,
      operationId: randomUUID(),
    },
    { ...runner, requestId },
  );
  return requestId;
}

const events = (requestId: string, eventType: string) =>
  db.auditEvent.findMany({ where: { requestId, eventType } });

const group = (target: ReturnType<typeof workspace>, groupId: string, extra: object = {}) => ({
  provider: providerKey,
  groupId,
  scopes: [`${target.name}:a`],
  ...extra,
});
const sha256Pattern = /^[a-f0-9]{64}$/;

describe("client_policy.updated audit event", () => {
  it("records a policy-only group change without a scope event", async () => {
    const target = workspace("policy-only");
    await apply(target, { groupAssignments: { dev: group(target, "policy-only") } });
    const requestId = await apply(target, {
      groupAssignments: {
        dev: group(target, "policy-only", { policy: { version: 1, shell: true } }),
      },
    });
    const [event, ...rest] = await events(requestId, "client_policy.updated");
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      subjectType: "group_scope_assignment",
      metadata: {
        target: "group",
        providerKey,
        groupId: "policy-only",
        changedFields: ["shell"],
        beforeSha256: null,
        afterSha256: expect.stringMatching(sha256Pattern),
        source: "weldall_up",
      },
    });
    await expect(events(requestId, "group_scopes.replaced")).resolves.toEqual([]);
  });

  it("records nothing when the manifest is applied again unchanged", async () => {
    const target = workspace("unchanged");
    const document = {
      groupAssignments: {
        dev: group(target, "unchanged", { policy: { version: 1, shell: true } }),
      },
    };
    await apply(target, document);
    const requestId = await apply(target, document);
    await expect(events(requestId, "client_policy.updated")).resolves.toEqual([]);
  });

  it("records the policy removal when the assignment is deleted", async () => {
    const target = workspace("deleted");
    await apply(target, {
      groupAssignments: { dev: group(target, "deleted", { policy: { version: 1, shell: true } }) },
    });
    const requestId = await apply(target, {});
    const [event, ...rest] = await events(requestId, "client_policy.updated");
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      subjectType: "group_scope_assignment",
      metadata: {
        target: "group",
        groupId: "deleted",
        changedFields: ["shell"],
        beforeSha256: expect.stringMatching(sha256Pattern),
        afterSha256: null,
      },
    });
    await expect(events(requestId, "group_scopes.deleted")).resolves.toHaveLength(1);
  });

  it("records nothing when the admin UI edits only scopes", async () => {
    const target = workspace("admin");
    await apply(target, {
      groupAssignments: { dev: group(target, "admin", { policy: { version: 1, shell: true } }) },
    });
    const assignment = await db.groupScopeAssignment.findFirstOrThrow({
      where: { provider: { key: providerKey }, groupId: "admin" },
    });
    const requestId = `${prefix}-${randomUUID()}`;
    await replaceGroupAssignment(
      {
        id: assignment.id,
        scopeKeys: [`${target.name}:a`, `${target.name}:b`],
        expectedVersion: assignment.version,
      },
      { id: `${prefix}-admin`, email: `${runId}@example.com`, requestId },
    );
    await expect(events(requestId, "group_scopes.replaced")).resolves.toHaveLength(1);
    await expect(events(requestId, "client_policy.updated")).resolves.toEqual([]);
  });

  it("records a cleared default policy", async () => {
    const target = workspace("default");
    const logoUrl = originalCli!.logoUrl;
    await apply(target, {
      cli: { logoUrl, policy: { version: 1, approvalMode: "smart_approve", shell: false } },
    });
    const requestId = await apply(target, { cli: { logoUrl, policy: null } });
    const [event, ...rest] = await events(requestId, "client_policy.updated");
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      subjectType: "cli_settings",
      subjectId: "default",
      metadata: {
        target: "default",
        changedFields: ["approvalMode", "shell"],
        beforeSha256: expect.stringMatching(sha256Pattern),
        afterSha256: null,
        source: "weldall_up",
      },
    });
  });

  const writeDefaultEvent = (extra: object) =>
    prismaAuditWriter.write({
      eventType: "client_policy.updated",
      actorType: "machine",
      actorId: `${prefix}-writer`,
      requestId: `${prefix}-${randomUUID()}`,
      outcome: "success",
      subjectType: "cli_settings",
      subjectId: "default",
      metadata: {
        target: "default",
        beforeSha256: null,
        afterSha256: "0".repeat(64),
        changedFields: ["shell"],
        source: "weldall_up",
        ...extra,
      },
    });

  it("accepts default policy metadata with digests and field names only", async () => {
    await expect(writeDefaultEvent({})).resolves.toBeUndefined();
  });

  it("rejects policy content in the metadata", async () => {
    await expect(writeDefaultEvent({ instructions: "Internal text" })).rejects.toThrow();
  });

  it("rejects group fields on a default policy event", async () => {
    await expect(writeDefaultEvent({ groupId: "dev" })).rejects.toThrow();
  });
});
