import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db, IAC_SCOPE_KEY } from "@weldall/db";
import { calculateJwkThumbprint } from "jose";
import { generateEs256KeyPair } from "@weldall/sdk";
import { digest, parseDesiredState } from "../src/server/iac/contracts";
import { applyIac, getIacState, planIac, type IacActor } from "../src/server/iac/service";
import { createPostgresReplayStore } from "../src/server/oauth/replay";
import {
  deleteMachine,
  mutateScope,
  reconcileMachine,
  type MutationActor,
} from "../src/server/domain/primitive-mutations";
import { lockConfigurationChanges } from "../src/server/domain/configuration";

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
  await db.auditEvent.deleteMany({
    where: { OR: [{ actorId: { startsWith: prefix } }, { requestId: { startsWith: prefix } }] },
  });
  await db.machineClient.deleteMany({ where: { clientId: { startsWith: prefix } } });
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
