import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db, IAC_SCOPE_KEY } from "@weldall/db";
import { calculateJwkThumbprint } from "jose";
import { generateEs256KeyPair } from "@weldall/sdk";
import { digest, parseDesiredState } from "../src/server/iac/contracts";
import {
  applyIac,
  getIacState,
  planIac,
  unmanageIac,
  type IacActor,
} from "../src/server/iac/service";
import { createPostgresReplayStore } from "../src/server/oauth/replay";
import {
  deleteMachine,
  mutateScope,
  reconcileMachine,
  type MutationActor,
} from "../src/server/domain/primitive-mutations";
import { lockConfigurationChanges } from "../src/server/domain/configuration";
import {
  createGroupProvider,
  deleteGroupProvider,
  updateGroupProvider,
} from "../src/server/group-providers/service";

const runId = randomUUID().replaceAll("-", "");
const prefix = `iacdb-${runId}`;
const actor: MutationActor = {
  type: "machine",
  id: `${prefix}-runner`,
  requestId: `${prefix}-request`,
  source: "weldall_up",
};

afterAll(async () => {
  await db.iacOperation.deleteMany({ where: { workspace: { name: { startsWith: prefix } } } });
  await db.iacObjectBinding.deleteMany({ where: { workspace: { name: { startsWith: prefix } } } });
  await db.iacWorkspace.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.machineAllowedScope.deleteMany({
    where: { client: { clientId: { startsWith: prefix } } },
  });
  await db.machineAllowedResource.deleteMany({
    where: { client: { clientId: { startsWith: prefix } } },
  });
  await db.resourceScope.deleteMany({
    where: { resource: { key: { startsWith: prefix } } },
  });
  await db.auditEvent.deleteMany({
    where: { OR: [{ actorId: { startsWith: prefix } }, { requestId: { startsWith: prefix } }] },
  });
  await db.machineClient.deleteMany({ where: { clientId: { startsWith: prefix } } });
  await db.downstreamResource.deleteMany({ where: { key: { startsWith: prefix } } });
  await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: { contains: runId } } });
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.groupScopeAssignment.deleteMany({
    where: { provider: { key: { startsWith: prefix } } },
  });
  await db.groupProvider.deleteMany({ where: { key: { startsWith: prefix } } });
  await db.scope.deleteMany({ where: { key: { startsWith: prefix } } });
  await db.replayMarker.deleteMany({ where: { key: { startsWith: prefix } } });
});

describe("IaC database transaction contracts", () => {
  it("rolls primitive writes and audits back as one transaction", async () => {
    const key = `${prefix}:rollback`;
    await expect(
      db.$transaction(async (tx) => {
        await lockConfigurationChanges(tx);
        await mutateScope(tx, { action: "create", key, description: "Rollback" }, actor);
        throw new Error("injected audit/reference failure");
      }),
    ).rejects.toThrow("injected audit/reference failure");
    await expect(db.scope.count({ where: { key } })).resolves.toBe(0);
    await expect(
      db.auditEvent.count({
        where: { requestId: actor.requestId, subjectType: "scope_definition" },
      }),
    ).resolves.toBe(0);
  });

  it("uses expected versions so only one concurrent mutation commits", async () => {
    const key = `${prefix}:concurrent`;
    const created = await db.$transaction(async (tx) => {
      await lockConfigurationChanges(tx);
      return mutateScope(tx, { action: "create", key, description: "Initial" }, actor);
    });
    const outcomes = await Promise.allSettled([
      db.$transaction(async (tx) => {
        await lockConfigurationChanges(tx);
        return mutateScope(
          tx,
          {
            action: "update",
            id: created.id,
            description: "First",
            expectedVersion: created.version,
          },
          actor,
        );
      }),
      db.$transaction(async (tx) => {
        await lockConfigurationChanges(tx);
        return mutateScope(
          tx,
          {
            action: "update",
            id: created.id,
            description: "Second",
            expectedVersion: created.version,
          },
          actor,
        );
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(db.scope.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
      version: created.version + 1,
    });
  });

  it("serializes group-provider admin writes under the configuration lock and version", async () => {
    const priorEncryptionKey = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY;
    process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const adminActor = {
      id: `${prefix}-provider-admin`,
      requestId: `${prefix}-provider-request`,
      source: "admin_api" as const,
    };
    const key = `${prefix}-locked-provider`;
    try {
      const provider = await createGroupProvider(
        {
          key,
          name: "Locked provider",
          adapterType: "management-api-v1",
          baseUrl: "https://provider.example.com",
          token: "provider-token",
          enabled: true,
        },
        adminActor,
      );
      const outcomes = await Promise.allSettled([
        updateGroupProvider(
          {
            id: provider.id,
            name: "First update",
            baseUrl: provider.baseUrl,
            enabled: true,
            expectedVersion: provider.version,
          },
          adminActor,
        ),
        updateGroupProvider(
          {
            id: provider.id,
            name: "Second update",
            baseUrl: provider.baseUrl,
            enabled: true,
            expectedVersion: provider.version,
          },
          adminActor,
        ),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const current = await db.groupProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(current.version).toBe(provider.version + 1);
      await deleteGroupProvider({ id: provider.id, expectedVersion: current.version }, adminActor);
    } finally {
      if (priorEncryptionKey === undefined) delete process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY;
      else process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = priorEncryptionKey;
    }
  });

  it("never persists private key coordinates in machine audits or thrown errors", async () => {
    const clientId = `${prefix}-machine`;
    const publicJwk = (await generateEs256KeyPair()).publicJwk;
    const machine = await db.$transaction(async (tx) => {
      await lockConfigurationChanges(tx);
      return reconcileMachine(
        tx,
        {
          clientId,
          name: "IaC DB machine",
          enabled: true,
          resourceKeys: [],
          scopeKeys: [],
          publicKeys: { current: publicJwk },
          expectedVersion: null,
        },
        actor,
      );
    });
    const audits = await db.auditEvent.findMany({ where: { requestId: actor.requestId } });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(publicJwk.x);
    expect(serialized).not.toContain(publicJwk.y);
    const rejected = await db
      .$transaction(async (tx) => {
        await lockConfigurationChanges(tx);
        return reconcileMachine(
          tx,
          {
            id: machine.id,
            clientId,
            name: machine.name,
            enabled: true,
            resourceKeys: [],
            scopeKeys: [],
            publicKeys: { current: { ...publicJwk, d: "private-secret" } },
            expectedVersion: machine.version,
          },
          actor,
        );
      })
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect(JSON.stringify(rejected)).not.toContain("private-secret");
    expect(JSON.stringify(rejected)).not.toContain(publicJwk.x);
    await db.$transaction(async (tx) => {
      await lockConfigurationChanges(tx);
      await deleteMachine(tx, { id: machine.id, expectedVersion: machine.version }, actor);
    });
  });

  it("applies atomically, rejects stale/concurrent snapshots, and replays idempotently", async () => {
    const iacScope = await db.scope.findUniqueOrThrow({ where: { key: IAC_SCOPE_KEY } });
    const adminScope = await db.scope.findUniqueOrThrow({ where: { key: "weldall:administer" } });
    const keys = await generateEs256KeyPair();
    const thumbprint = await calculateJwkThumbprint(keys.publicJwk, "sha256");
    const clientId = `${prefix}-apply-runner`;
    const keyId = "current";
    await db.machineClient.create({
      data: {
        clientId,
        name: "Apply runner",
        createdBy: actor.id,
        updatedBy: actor.id,
        keys: {
          create: {
            kid: keyId,
            publicJwk: keys.publicJwk,
            thumbprint,
            createdBy: actor.id,
          },
        },
        allowedScopes: { create: { scopeId: iacScope.id } },
      },
    });
    const email = `${runId}-iac-admin@example.com`;
    await db.user.create({
      data: { id: `${prefix}-admin-user`, name: "IaC admin", email, emailVerified: true },
    });
    await db.emailScopeAssignment.create({
      data: {
        normalizedEmail: email,
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: { create: { id: randomUUID(), scopeId: adminScope.id, createdBy: actor.id } },
      },
    });
    const iacActor: IacActor = {
      clientId,
      keyId,
      keyThumbprint: thumbprint,
      requestId: `${prefix}-apply-request`,
    };
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1alpha1",
      workspace: {
        id: randomUUID(),
        name: `${prefix}-workspace`,
        issuer: "https://weldall.example.com",
      },
      scopes: { managed: { key: `${prefix}:managed`, description: "Managed" } },
    });
    const plan = await planIac(manifest);
    const request = {
      manifest,
      plannedRevision: plan.revision,
      configDigest: plan.configDigest,
      planDigest: plan.digest,
      operationId: randomUUID(),
    };
    const committed = await applyIac(request, iacActor);
    await expect(applyIac(request, iacActor)).resolves.toEqual(committed);
    await expect(getIacState(manifest.workspace.id)).resolves.toMatchObject({
      objects: [
        {
          address: "scope.managed",
          kind: "scope",
          identity: `${prefix}:managed`,
          objectId: expect.any(String),
          observedVersion: 1,
        },
      ],
    });
    const rejectedRequestId = `${prefix}-invalid-apply-request`;
    await expect(
      applyIac(
        { ...request, operationId: randomUUID(), configDigest: "0".repeat(64) },
        { ...iacActor, requestId: rejectedRequestId },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_DIGEST_MISMATCH" });
    await expect(
      db.auditEvent.findFirstOrThrow({ where: { requestId: rejectedRequestId } }),
    ).resolves.toMatchObject({ eventType: "iac.apply.failed", reasonCode: "invalid_request" });

    const changed = parseDesiredState({
      ...manifest,
      scopes: { managed: { key: `${prefix}:managed`, description: "Changed" } },
    });
    const concurrentPlan = await planIac(changed);
    const outcomes = await Promise.allSettled([
      applyIac(
        {
          manifest: changed,
          plannedRevision: concurrentPlan.revision,
          configDigest: concurrentPlan.configDigest,
          planDigest: concurrentPlan.digest,
          operationId: randomUUID(),
        },
        iacActor,
      ),
      applyIac(
        {
          manifest: changed,
          plannedRevision: concurrentPlan.revision,
          configDigest: concurrentPlan.configDigest,
          planDigest: concurrentPlan.digest,
          operationId: randomUUID(),
        },
        iacActor,
      ),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const scope = await db.scope.findUniqueOrThrow({ where: { key: `${prefix}:managed` } });
    await db.scope.delete({ where: { id: scope.id } });
    const tombstonePlan = await planIac(changed);
    expect(tombstonePlan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "recreate", address: "scope.managed" }),
      ]),
    );
    await applyIac(
      {
        manifest: changed,
        plannedRevision: tombstonePlan.revision,
        configDigest: tombstonePlan.configDigest,
        planDigest: tombstonePlan.digest,
        operationId: randomUUID(),
      },
      iacActor,
    );
    await expect(
      db.scope.findUnique({ where: { key: `${prefix}:managed` } }),
    ).resolves.not.toBeNull();
  });

  it("rejects replacing the authenticated machine through a clientId change", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-self-replacement-request`,
    };
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-self-replacement`,
      issuer: "https://weldall.example.com",
    };
    await db.iacWorkspace.create({ data: workspace });
    await db.iacObjectBinding.create({
      data: {
        workspaceId: workspace.id,
        address: "machine.runner",
        kind: "MACHINE",
        naturalIdentity: runner.clientId,
        machineClientId: runner.id,
      },
    });
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1alpha1",
      workspace,
      machines: {
        runner: {
          clientId: `${runner.clientId}-renamed`,
          name: runner.name,
          enabled: true,
          publicKeys: { [runner.keys[0]!.kid]: runner.keys[0]!.publicJwk },
          resources: [],
          scopes: [IAC_SCOPE_KEY],
        },
      },
    });
    const plan = await planIac(manifest);
    expect(plan.actions).toEqual([
      expect.objectContaining({ address: "machine.runner", action: "replace" }),
    ]);
    await expect(
      applyIac(
        {
          manifest,
          plannedRevision: plan.revision,
          configDigest: plan.configDigest,
          planDigest: plan.digest,
          operationId: randomUUID(),
        },
        iacActor,
      ),
    ).rejects.toMatchObject({ code: "CALLER_SELF_PROTECTION" });
    await expect(
      db.machineClient.findUnique({ where: { clientId: runner.clientId } }),
    ).resolves.not.toBeNull();
  });

  it("replaces immutable resource identifiers with a new row and object ID", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-replacement-request`,
    };
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-replacement`,
      issuer: "https://weldall.example.com",
    };
    const resource = (identifier: string) =>
      parseDesiredState({
        apiVersion: "weldall.dev/v1alpha1",
        workspace,
        resources: {
          api: {
            key: `${prefix}-api`,
            name: "API",
            resourceIdentifier: identifier,
            authorizationServer: "https://auth.example.com",
            downstreamClientId: "api",
            enabled: true,
            skillDiscoveryEnabled: false,
            requestPrefixes: [identifier],
            scopes: [],
          },
        },
      });
    const apply = async (manifest: ReturnType<typeof resource>) => {
      const plan = await planIac(manifest);
      return applyIac(
        {
          manifest,
          plannedRevision: plan.revision,
          configDigest: plan.configDigest,
          planDigest: plan.digest,
          operationId: randomUUID(),
        },
        iacActor,
      );
    };
    const oldIdentifier = `https://replace-old-${runId}.example.com/api`;
    const newIdentifier = `https://replace-new-${runId}.example.com/api`;
    await apply(resource(oldIdentifier));
    const before = await db.downstreamResource.findUniqueOrThrow({
      where: { key: `${prefix}-api` },
    });
    await apply(resource(newIdentifier));
    const after = await db.downstreamResource.findUniqueOrThrow({
      where: { key: `${prefix}-api` },
    });
    expect(after.id).not.toBe(before.id);
    expect(after.resourceIdentifier).toBe(newIdentifier);
  });

  it("replaces a scope after staging same-workspace resource and machine relations", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-scope-replacement-request`,
    };
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-scope-replacement`,
      issuer: "https://weldall.example.com",
    };
    const makeManifest = (scopeKey: string) =>
      parseDesiredState({
        apiVersion: "weldall.dev/v1alpha1",
        workspace,
        scopes: { access: { key: scopeKey, description: "Access" } },
        resources: {
          api: {
            key: `${prefix}-scope-api`,
            name: "Scope API",
            resourceIdentifier: `https://scope-${runId}.example.com/api`,
            authorizationServer: "https://auth.example.com",
            downstreamClientId: "scope-api",
            enabled: true,
            skillDiscoveryEnabled: false,
            requestPrefixes: [`https://scope-${runId}.example.com/api`],
            scopes: [scopeKey],
          },
        },
        machines: {
          consumer: {
            clientId: `${prefix}-scope-consumer`,
            name: "Scope consumer",
            enabled: true,
            publicKeys: {},
            resources: [`${prefix}-scope-api`],
            scopes: [scopeKey],
          },
        },
      });
    const apply = async (manifest: ReturnType<typeof makeManifest>) => {
      const plan = await planIac(manifest);
      expect(plan.blockers).toEqual([]);
      return applyIac(
        {
          manifest,
          plannedRevision: plan.revision,
          configDigest: plan.configDigest,
          planDigest: plan.digest,
          operationId: randomUUID(),
        },
        iacActor,
      );
    };
    const assignmentEmail = `${runId}-scope-replacement@example.com`;
    const makeFullManifest = (scopeKey: string) =>
      parseDesiredState({
        ...makeManifest(scopeKey),
        emailAssignments: {
          person: { email: assignmentEmail, scopes: [scopeKey] },
        },
      });
    const oldKey = `${prefix}:old-access`;
    const newKey = `${prefix}:new-access`;
    await apply(makeFullManifest(oldKey));
    const oldScope = await db.scope.findUniqueOrThrow({ where: { key: oldKey } });
    await apply(makeFullManifest(newKey));
    await expect(db.scope.findUnique({ where: { key: oldKey } })).resolves.toBeNull();
    const newScope = await db.scope.findUniqueOrThrow({ where: { key: newKey } });
    expect(newScope.id).not.toBe(oldScope.id);
    await expect(
      db.downstreamResource.findUniqueOrThrow({
        where: { key: `${prefix}-scope-api` },
        include: { scopes: { include: { scope: true } } },
      }),
    ).resolves.toMatchObject({ scopes: [{ scope: { key: newKey } }] });
    await expect(
      db.machineClient.findUniqueOrThrow({
        where: { clientId: `${prefix}-scope-consumer` },
        include: { allowedScopes: { include: { scope: true } } },
      }),
    ).resolves.toMatchObject({ allowedScopes: [{ scope: { key: newKey } }] });
    await expect(
      db.emailScopeAssignment.findUniqueOrThrow({
        where: { normalizedEmail: assignmentEmail },
        include: { grants: { include: { scope: true } } },
      }),
    ).resolves.toMatchObject({ grants: [{ scope: { key: newKey } }] });
  });

  it("blocks owned scope deletion while manual email and group assignments reference it", async () => {
    const workspaceId = randomUUID();
    const scope = await db.scope.create({
      data: {
        key: `${prefix}:referenced`,
        description: "Referenced",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    await db.iacWorkspace.create({
      data: {
        id: workspaceId,
        name: `${prefix}-references`,
        issuer: "https://weldall.example.com",
      },
    });
    const scopeBinding = await db.iacObjectBinding.create({
      data: {
        workspaceId,
        address: "scope.referenced",
        kind: "SCOPE",
        naturalIdentity: scope.key,
        scopeId: scope.id,
      },
    });
    await expect(
      db.$executeRaw`UPDATE "IacObjectBinding" SET "kind" = 'RESOURCE' WHERE "id" = ${scopeBinding.id}`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`INSERT INTO "IacInstallation" ("id", "installationId") VALUES ('extra', ${randomUUID()}::uuid)`,
    ).rejects.toThrow();
    await db.emailScopeAssignment.create({
      data: {
        normalizedEmail: `${runId}-manual-ref@example.com`,
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: { create: { id: randomUUID(), scopeId: scope.id, createdBy: actor.id } },
      },
    });
    const provider = await db.groupProvider.create({
      data: {
        key: `${prefix}-provider`,
        name: "Provider",
        adapterType: "management-api-v1",
        baseUrl: "https://groups.example.com",
        encryptedToken: "test",
        encryptionKeyVersion: 1,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    await db.groupScopeAssignment.create({
      data: {
        providerId: provider.id,
        groupId: "manual-group",
        groupName: "Manual group",
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: { create: { scopeId: scope.id, createdBy: actor.id } },
      },
    });
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1alpha1",
      workspace: {
        id: workspaceId,
        name: `${prefix}-references`,
        issuer: "https://weldall.example.com",
      },
    });
    const plan = await planIac(manifest);
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EXTERNAL_REFERENCE", address: "scope.referenced" }),
      ]),
    );
    expect(plan.blockers.filter(({ address }) => address === "scope.referenced")).toHaveLength(2);

    const email = await db.emailScopeAssignment.findUniqueOrThrow({
      where: { normalizedEmail: `${runId}-manual-ref@example.com` },
    });
    await db.iacObjectBinding.create({
      data: {
        workspaceId,
        address: "emailAssignment.manual",
        kind: "EMAIL_ASSIGNMENT",
        naturalIdentity: email.normalizedEmail,
        emailAssignmentId: email.id,
      },
    });
    const relationRemoval = parseDesiredState({
      ...manifest,
      emailAssignments: {
        manual: { email: email.normalizedEmail, scopes: ["weldall:login"] },
      },
    });
    const relationPlan = await planIac(relationRemoval);
    expect(relationPlan.blockers).toHaveLength(1);
    expect(relationPlan.blockers[0]!.message).toMatch(/group assignment/);
  });

  it("enforces declaration absence for REST unmanage and replays idempotently", async () => {
    const owned = await db.iacObjectBinding.findFirstOrThrow({
      where: { workspace: { name: `${prefix}-workspace` }, address: "scope.managed" },
      include: { workspace: true },
    });
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-unmanage-request`,
    };
    const declared = parseDesiredState({
      apiVersion: "weldall.dev/v1alpha1",
      workspace: {
        id: owned.workspace.id,
        name: owned.workspace.name,
        issuer: owned.workspace.issuer,
      },
      scopes: {
        managed: { key: owned.naturalIdentity, description: "Changed" },
      },
    });
    await expect(
      unmanageIac(
        {
          workspaceId: owned.workspace.id,
          address: owned.address,
          manifest: declared,
          configDigest: digest(declared),
          operationId: randomUUID(),
        },
        iacActor,
      ),
    ).rejects.toMatchObject({ code: "DECLARATION_PRESENT" });
    const absent = parseDesiredState({ ...declared, scopes: {} });
    const request = {
      workspaceId: owned.workspace.id,
      address: owned.address,
      manifest: absent,
      configDigest: digest(absent),
      operationId: randomUUID(),
    };
    const result = await unmanageIac(request, iacActor);
    await expect(unmanageIac(request, iacActor)).resolves.toEqual(result);
    await expect(db.iacObjectBinding.findUnique({ where: { id: owned.id } })).resolves.toBeNull();
    await expect(db.scope.findUnique({ where: { id: owned.scopeId! } })).resolves.not.toBeNull();
  });

  it("rolls a complete apply back when aggregate audit persistence fails", async () => {
    const workspaceId = randomUUID();
    const key = `${prefix}:audit-rollback`;
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1alpha1",
      workspace: {
        id: workspaceId,
        name: `${prefix}-failing-workspace`,
        issuer: "https://weldall.example.com",
      },
      scopes: { rollback: { key, description: "Must roll back" } },
    });
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-audit-failure-request`,
    };
    const plan = await planIac(manifest);
    const functionName = `reject_iac_audit_${runId}`;
    const triggerName = `reject_iac_audit_${runId}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."eventType" = 'iac.apply.succeeded' AND NEW."requestId" = '${iacActor.requestId}' THEN
          RAISE EXCEPTION 'injected aggregate audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "AuditEvent"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      await expect(
        applyIac(
          {
            manifest,
            plannedRevision: plan.revision,
            configDigest: digest(manifest),
            planDigest: plan.digest,
            operationId: randomUUID(),
          },
          iacActor,
        ),
      ).rejects.toThrow();
      await expect(db.scope.count({ where: { key } })).resolves.toBe(0);
      await expect(db.iacWorkspace.count({ where: { id: workspaceId } })).resolves.toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "AuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });

  it("atomically rejects replay across separately constructed PostgreSQL stores", async () => {
    const key = `${prefix}:replay`;
    const expiresAt = new Date(Date.now() + 60_000);
    const results = await Promise.all([
      createPostgresReplayStore().consume(key, expiresAt),
      createPostgresReplayStore().consume(key, expiresAt),
    ]);
    expect(results.sort()).toEqual([false, true]);
    await expect(createPostgresReplayStore().consume(key, expiresAt)).resolves.toBe(false);
  });
});
