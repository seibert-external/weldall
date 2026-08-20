import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db, IAC_SCOPE_KEY } from "@weldall/db";
import { calculateJwkThumbprint } from "jose";
import { generateEs256KeyPair } from "@weldall/sdk";
import { digest, parseDesiredState } from "../src/server/iac/contracts";
import {
  applyIac,
  getIacState,
  importIac,
  moveIacState,
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
import { deleteSkill, getSkill, updateSkill } from "../src/server/admin/service";
import {
  createGroupProvider,
  deleteGroupProvider,
  updateGroupProvider,
} from "../src/server/group-providers/service";

const runId = randomUUID().replaceAll("-", "");
const prefix = `iacdb-${runId}`;
let originalCliLogoUrl: string | undefined;
const actor: MutationActor = {
  type: "machine",
  id: `${prefix}-runner`,
  requestId: `${prefix}-request`,
  source: "weldall_up",
};

afterAll(async () => {
  if (originalCliLogoUrl !== undefined)
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: originalCliLogoUrl },
    });
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
  await db.machineClient.deleteMany({ where: { clientId: IAC_SCOPE_KEY } });
  await db.downstreamResource.deleteMany({ where: { key: { startsWith: prefix } } });
  await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: { contains: runId } } });
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.groupScopeAssignment.deleteMany({
    where: { provider: { key: { startsWith: prefix } } },
  });
  await db.groupProvider.deleteMany({ where: { key: { startsWith: prefix } } });
  await db.skill.deleteMany({ where: { slug: { startsWith: prefix } } });
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

  it("plans recreation after an IaC-managed resource is manually deleted", async () => {
    const key = `${prefix}-resource-tombstone`;
    const resourceIdentifier = `https://${key}.example.com/api`;
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-resource-tombstone-workspace`,
      issuer: "https://weldall.example.com",
    };
    const resource = await db.downstreamResource.create({
      data: {
        key,
        name: "Managed resource",
        resourceIdentifier,
        authorizationServer: `https://${key}.example.com`,
        downstreamClientId: key,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    await db.iacWorkspace.create({ data: workspace });
    await db.iacObjectBinding.create({
      data: {
        workspaceId: workspace.id,
        address: "resource.managed",
        kind: "RESOURCE",
        naturalIdentity: key,
        resourceId: resource.id,
      },
    });
    await db.downstreamResource.delete({ where: { id: resource.id } });

    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace,
      resources: {
        managed: {
          key,
          name: "Managed resource",
          resourceIdentifier,
          authorizationServer: `https://${key}.example.com`,
          downstreamClientId: key,
          enabled: true,
          requestPrefixes: [resourceIdentifier],
          scopes: [],
        },
      },
    });

    await expect(planIac(manifest)).resolves.toMatchObject({
      actions: [
        expect.objectContaining({
          action: "recreate",
          address: "resource.managed",
          drift: true,
        }),
      ],
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
    const cliSettings = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
    originalCliLogoUrl ??= cliSettings.logoUrl;
    const logoUrl = `https://${prefix}.example/logo.svg`;
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace: {
        id: randomUUID(),
        name: `${prefix}-workspace`,
        issuer: "https://weldall.example.com",
      },
      cli: { logoUrl },
      scopes: { managed: { key: `${prefix}:managed`, description: "Managed" } },
      skills: {
        review: {
          slug: `${prefix}.review`,
          title: "Review",
          content: "# Private initial content",
          requiredScopes: [`${prefix}:managed`],
          visibility: "HIDDEN_IF_UNALLOWED",
          meta: { tags: ["managed", ""], owner: `${prefix}-owner` },
          lastUpdatedAt: "managed-revision-one",
        },
      },
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
    await expect(
      db.cliSettings.findUniqueOrThrow({ where: { id: "default" } }),
    ).resolves.toMatchObject({
      logoUrl,
    });
    await expect(
      db.skill.findUniqueOrThrow({ where: { slug: `${prefix}.review` } }),
    ).resolves.toMatchObject({
      meta: { tags: ["managed", ""], owner: `${prefix}-owner` },
      lastUpdatedAt: "managed-revision-one",
    });
    await expect(getIacState(manifest.workspace.id)).resolves.toMatchObject({
      objects: expect.arrayContaining([
        {
          address: "scope.managed",
          kind: "scope",
          identity: `${prefix}:managed`,
          objectId: expect.any(String),
          observedVersion: 1,
          tombstone: false,
        },
        {
          address: "skill.review",
          kind: "skill",
          identity: `${prefix}.review`,
          objectId: expect.any(String),
          observedVersion: 1,
          tombstone: false,
        },
      ]),
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
      skills: {
        review: {
          ...manifest.skills.review!,
          title: "Changed review",
          content: "# Private changed content",
        },
      },
    });
    const planBeforeAdminEdit = await planIac(changed);
    const skillBeforeAdminEdit = await db.skill.findUniqueOrThrow({
      where: { slug: `${prefix}.review` },
    });
    const adminEditedSkill = await updateSkill(
      {
        id: skillBeforeAdminEdit.id,
        title: "Intervening admin edit",
        content: "# Intervening private admin edit",
        requiredScopes: skillBeforeAdminEdit.requiredScopes,
        visibility: skillBeforeAdminEdit.visibility,
        expectedVersion: skillBeforeAdminEdit.version,
      },
      {
        id: `${prefix}-admin-editor`,
        email: `${runId}-editor@example.com`,
        requestId: `${prefix}-admin-edit-request`,
      },
    );
    const concurrentPlan = await planIac(changed);
    expect(concurrentPlan.digest).not.toBe(planBeforeAdminEdit.digest);
    expect(concurrentPlan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: "skill.review",
          action: "update",
          observedVersion: adminEditedSkill.version,
        }),
      ]),
    );
    await expect(
      applyIac(
        {
          manifest: changed,
          plannedRevision: planBeforeAdminEdit.revision,
          configDigest: planBeforeAdminEdit.configDigest,
          planDigest: planBeforeAdminEdit.digest,
          operationId: randomUUID(),
        },
        iacActor,
      ),
    ).rejects.toMatchObject({ code: "STALE_PLAN" });

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
    const skillAudits = await db.auditEvent.findMany({
      where: {
        requestId: iacActor.requestId,
        eventType: { in: ["skill.created", "skill.updated"] },
      },
    });
    expect(skillAudits).not.toHaveLength(0);
    expect(JSON.stringify(skillAudits)).not.toContain("Private initial content");
    expect(JSON.stringify(skillAudits)).not.toContain("Private changed content");
    expect(
      skillAudits.every((event) => JSON.stringify(event.metadata).includes("contentSha256")),
    ).toBe(true);

    const managedSkill = await db.skill.findUniqueOrThrow({
      where: { slug: `${prefix}.review` },
    });
    await db.skill.update({
      where: { id: managedSkill.id },
      data: { title: "Manual drift", content: "# Do not expose this drift" },
    });
    const skillDriftPlan = await planIac(changed);
    expect(skillDriftPlan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "update", address: "skill.review", drift: true }),
      ]),
    );
    expect(JSON.stringify(skillDriftPlan)).not.toContain("Do not expose this drift");
    await applyIac(
      {
        manifest: changed,
        plannedRevision: skillDriftPlan.revision,
        configDigest: skillDriftPlan.configDigest,
        planDigest: skillDriftPlan.digest,
        operationId: randomUUID(),
      },
      iacActor,
    );
    await db.skill.delete({ where: { id: managedSkill.id } });
    const skillTombstonePlan = await planIac(changed);
    expect(skillTombstonePlan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "recreate", address: "skill.review" }),
      ]),
    );
    await applyIac(
      {
        manifest: changed,
        plannedRevision: skillTombstonePlan.revision,
        configDigest: skillTombstonePlan.configDigest,
        planDigest: skillTombstonePlan.digest,
        operationId: randomUUID(),
      },
      iacActor,
    );

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

    const withoutSkill = parseDesiredState({ ...changed, skills: {} });
    const deletionPlan = await planIac(withoutSkill);
    expect(deletionPlan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "delete", address: "skill.review" }),
      ]),
    );
    await applyIac(
      {
        manifest: withoutSkill,
        plannedRevision: deletionPlan.revision,
        configDigest: deletionPlan.configDigest,
        planDigest: deletionPlan.digest,
        operationId: randomUUID(),
      },
      iacActor,
    );
    await expect(db.skill.findUnique({ where: { slug: `${prefix}.review` } })).resolves.toBeNull();
  });

  it("preserves imported skill management through admin update and recreates its tombstone", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-skill-lifecycle-request`,
    };
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-skill-lifecycle`,
      issuer: "https://weldall.example.com",
    };
    const manual = await db.skill.create({
      data: {
        slug: `${prefix}.imported`,
        title: "Imported skill",
        content: "# Imported private content",
        requiredScopes: [],
        visibility: "DEFAULT",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    const imported = await importIac(
      {
        workspace,
        kind: "skill",
        identity: manual.slug,
        address: "skill.imported",
        operationId: randomUUID(),
      },
      iacActor,
    );
    expect(imported.state).toMatchObject({ slug: manual.slug, content: manual.content });
    const binding = await db.iacObjectBinding.findUniqueOrThrow({
      where: {
        workspaceId_address: { workspaceId: workspace.id, address: "skill.imported" },
      },
    });
    const adminActor = {
      id: `${prefix}-skill-admin`,
      email: `${runId}-skill-admin@example.com`,
      requestId: `${prefix}-skill-admin-request`,
    };
    const adminUpdated = await updateSkill(
      {
        id: manual.id,
        title: "Admin-updated imported skill",
        content: "# Admin-updated imported private content",
        requiredScopes: [],
        visibility: "HIDDEN_IF_UNALLOWED",
        expectedVersion: manual.version,
      },
      adminActor,
    );
    await expect(getSkill(manual.id)).resolves.toMatchObject({
      title: adminUpdated.title,
      management: {
        type: "iac",
        workspaceId: workspace.id,
        address: "skill.imported",
      },
      readOnly: false,
    });
    await expect(
      db.iacObjectBinding.findUniqueOrThrow({ where: { id: binding.id } }),
    ).resolves.toMatchObject({ skillId: manual.id, naturalIdentity: manual.slug });

    await deleteSkill(
      { id: manual.id, expectedVersion: adminUpdated.version },
      { ...adminActor, requestId: `${prefix}-skill-admin-delete-request` },
    );
    await expect(
      db.iacObjectBinding.findUniqueOrThrow({ where: { id: binding.id } }),
    ).resolves.toMatchObject({ skillId: null, naturalIdentity: manual.slug });

    const desired = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace,
      skills: {
        imported: {
          slug: manual.slug,
          title: adminUpdated.title,
          content: adminUpdated.content,
          requiredScopes: adminUpdated.requiredScopes,
          visibility: adminUpdated.visibility,
        },
      },
    });
    const reoccupied = await db.skill.create({
      data: {
        slug: manual.slug,
        title: "Manual collision",
        content: "# Manual collision",
        requiredScopes: [],
        visibility: "DEFAULT",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    const collisionPlan = await planIac(desired);
    expect(collisionPlan.actions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "recreate" })]),
    );
    expect(collisionPlan.blockers).toEqual([
      expect.objectContaining({ address: "skill.imported", code: "MANUAL_COLLISION" }),
    ]);
    await expect(
      applyIac(
        {
          manifest: desired,
          plannedRevision: collisionPlan.revision,
          configDigest: collisionPlan.configDigest,
          planDigest: collisionPlan.digest,
          operationId: randomUUID(),
        },
        iacActor,
      ),
    ).rejects.toMatchObject({
      code: "PLAN_BLOCKED",
      details: {
        blockers: [
          expect.objectContaining({ address: "skill.imported", code: "MANUAL_COLLISION" }),
        ],
      },
    });

    await db.skill.delete({ where: { id: reoccupied.id } });
    const recreatePlan = await planIac(desired);
    expect(recreatePlan.blockers).toEqual([]);
    expect(recreatePlan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "recreate", address: "skill.imported" }),
      ]),
    );
    await applyIac(
      {
        manifest: desired,
        plannedRevision: recreatePlan.revision,
        configDigest: recreatePlan.configDigest,
        planDigest: recreatePlan.digest,
        operationId: randomUUID(),
      },
      iacActor,
    );
    const recreated = await db.skill.findUniqueOrThrow({ where: { slug: manual.slug } });
    await expect(getSkill(recreated.id)).resolves.toMatchObject({
      management: { type: "iac", workspaceId: workspace.id, address: "skill.imported" },
    });

    await moveIacState(
      {
        workspaceId: workspace.id,
        from: "skill.imported",
        to: "skill.renamed",
        operationId: randomUUID(),
      },
      iacActor,
    );
    const absent = parseDesiredState({ apiVersion: "weldall.dev/v1", workspace });
    await unmanageIac(
      {
        workspaceId: workspace.id,
        address: "skill.renamed",
        manifest: absent,
        configDigest: digest(absent),
        operationId: randomUUID(),
      },
      iacActor,
    );
    await expect(db.skill.findUnique({ where: { id: recreated.id } })).resolves.not.toBeNull();
    await expect(getSkill(recreated.id)).resolves.toMatchObject({ management: { type: "manual" } });
  });

  it("allows an IaC skill to override a discovered skill without binding the catalog row", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-discovered-override`,
    };
    const slug = `${prefix}.discovered`;
    const resource = await db.downstreamResource.create({
      data: {
        key: `${prefix}-discovery-source`,
        name: "Discovery source",
        resourceIdentifier: `https://${prefix}.example.com/api`,
        authorizationServer: `https://${prefix}.example.com`,
        downstreamClientId: `${prefix}-discovery-source`,
        enabled: true,
        skillDiscoveryEnabled: true,
        createdBy: actor.id,
        updatedBy: actor.id,
        discoveredCatalog: {
          create: {
            skills: {
              create: {
                localId: "discovered",
                canonicalId: slug,
                title: "Discovered",
                content: "# Discovered",
                requiredScopes: [],
                visibility: "DEFAULT",
              },
            },
          },
        },
      },
    });
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace: {
        id: randomUUID(),
        name: `${prefix}-discovered-override`,
        issuer: "https://weldall.example.com",
      },
      skills: {
        override: {
          slug,
          title: "Managed override",
          content: "# Managed override",
          requiredScopes: [],
          visibility: "DEFAULT",
        },
      },
    });
    const plan = await planIac(manifest);
    expect(plan.blockers).toEqual([]);
    await applyIac(
      {
        manifest,
        plannedRevision: plan.revision,
        configDigest: plan.configDigest,
        planDigest: plan.digest,
        operationId: randomUUID(),
      },
      iacActor,
    );
    await expect(db.skill.findUnique({ where: { slug } })).resolves.not.toBeNull();
    await expect(
      db.discoveredSkill.findUnique({ where: { canonicalId: slug } }),
    ).resolves.not.toBeNull();
    const binding = await db.iacObjectBinding.findFirstOrThrow({
      where: { skillId: { not: null }, naturalIdentity: slug },
    });
    expect(binding.skillId).not.toBeNull();
    expect(binding.resourceId).toBeNull();
    await db.downstreamResource.delete({ where: { id: resource.id } });
  });

  it("stages managed skill references during scope replacement and deletion", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-skill-scope-replacement`,
    };
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-skill-scope-replacement`,
      issuer: "https://weldall.example.com",
    };
    const state = (scopeKey: string) =>
      parseDesiredState({
        apiVersion: "weldall.dev/v1",
        workspace,
        scopes: { referenced: { key: scopeKey, description: "Referenced" } },
        skills: {
          referenced: {
            slug: `${prefix}.scope-reference`,
            title: "Scope reference",
            content: "# Scope reference",
            requiredScopes: [scopeKey],
            visibility: "DEFAULT",
          },
        },
      });
    const apply = async (manifest: ReturnType<typeof state>) => {
      const plan = await planIac(manifest);
      expect(plan.blockers).toEqual([]);
      await applyIac(
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
    const oldKey = `${prefix}:skill-old`;
    const newKey = `${prefix}:skill-new`;
    await apply(state(oldKey));
    await apply(state(newKey));
    await expect(db.scope.findUnique({ where: { key: oldKey } })).resolves.toBeNull();
    await expect(
      db.skill.findUniqueOrThrow({ where: { slug: `${prefix}.scope-reference` } }),
    ).resolves.toMatchObject({ requiredScopes: [newKey] });

    const removed = parseDesiredState({ apiVersion: "weldall.dev/v1", workspace });
    await apply(removed);
    await expect(db.scope.findUnique({ where: { key: newKey } })).resolves.toBeNull();
    await expect(
      db.skill.findUnique({ where: { slug: `${prefix}.scope-reference` } }),
    ).resolves.toBeNull();
  });

  it("applies an opaque group ID without contacting the configured provider", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const provider = await db.groupProvider.create({
      data: {
        key: `${prefix}-unavailable-provider`,
        name: "Unavailable provider",
        adapterType: "management-api-v1",
        baseUrl: "https://unavailable.invalid",
        encryptedToken: "not-used",
        encryptionKeyVersion: 1,
        enabled: false,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace: {
        id: randomUUID(),
        name: `${prefix}-opaque-group-workspace`,
        issuer: "https://weldall.example.com",
      },
      groupAssignments: {
        staged: {
          provider: provider.key,
          groupId: "future:group/id",
          scopes: [`${prefix}:managed`],
        },
      },
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
      {
        clientId: runner.clientId,
        keyId: runner.keys[0]!.kid,
        keyThumbprint: runner.keys[0]!.thumbprint,
        requestId: `${prefix}-opaque-group-request`,
      },
    );

    const assignment = await db.groupScopeAssignment.findUniqueOrThrow({
      where: { providerId_groupId: { providerId: provider.id, groupId: "future:group/id" } },
      include: { grants: { include: { scope: true } } },
    });
    expect(assignment).not.toHaveProperty("groupName");
    expect(assignment.grants.map(({ scope }) => scope.key)).toEqual([`${prefix}:managed`]);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { requestId: `${prefix}-opaque-group-request`, eventType: "group_scopes.created" },
    });
    expect(audit.metadata).not.toHaveProperty("groupName");
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
      apiVersion: "weldall.dev/v1",
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
        apiVersion: "weldall.dev/v1",
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
        apiVersion: "weldall.dev/v1",
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
      db.$executeRaw`INSERT INTO "InstallationIdentity" ("id", "installationId") VALUES ('extra', ${randomUUID()}::uuid)`,
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
        createdBy: actor.id,
        updatedBy: actor.id,
        grants: { create: { scopeId: scope.id, createdBy: actor.id } },
      },
    });
    const manualSkill = await db.skill.create({
      data: {
        slug: `${prefix}.manual-reference`,
        title: "Manual reference",
        content: "# Manual reference",
        requiredScopes: [scope.key],
        visibility: "DEFAULT",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1",
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
    expect(plan.blockers.filter(({ address }) => address === "scope.referenced")).toHaveLength(3);

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
    const skillBinding = await db.iacObjectBinding.create({
      data: {
        workspaceId,
        address: "skill.manual",
        kind: "SKILL",
        naturalIdentity: manualSkill.slug,
        skillId: manualSkill.id,
      },
    });
    await expect(
      db.$executeRaw`UPDATE "IacObjectBinding" SET "kind" = 'RESOURCE' WHERE "id" = ${skillBinding.id}`,
    ).rejects.toThrow();
    const relationRemoval = parseDesiredState({
      ...manifest,
      emailAssignments: {
        manual: { email: email.normalizedEmail, scopes: ["weldall:login"] },
      },
      skills: {
        manual: {
          slug: manualSkill.slug,
          title: manualSkill.title,
          content: manualSkill.content,
          requiredScopes: [],
          visibility: manualSkill.visibility,
        },
      },
    });
    const relationPlan = await planIac(relationRemoval);
    expect(relationPlan.blockers).toHaveLength(1);
    expect(relationPlan.blockers[0]!.message).toMatch(/group assignment/);
  });

  it("revalidates lifecycle authorization after waiting for the configuration lock", async () => {
    const iacScope = await db.scope.findUniqueOrThrow({ where: { key: IAC_SCOPE_KEY } });
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const activeKey = runner.keys[0]!;
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: activeKey.kid,
      keyThumbprint: activeKey.thumbprint,
      requestId: `${prefix}-lifecycle-auth-request`,
    };
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-lifecycle-auth`,
      issuer: "https://weldall.example.com",
    };
    await db.iacWorkspace.create({ data: workspace });
    const manual = await db.scope.create({
      data: {
        key: `${prefix}:lifecycle-import`,
        description: "Lifecycle import",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });

    const raceRevocation = async (
      revoke: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>,
      operation: () => Promise<unknown>,
    ) => {
      let pending!: Promise<unknown>;
      await db.$transaction(async (tx) => {
        await lockConfigurationChanges(tx);
        await revoke(tx);
        pending = operation();
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      await expect(pending).rejects.toMatchObject({ code: "AUTHORIZATION_REVOKED" });
    };
    await raceRevocation(
      (tx) =>
        tx.machineAllowedScope.delete({
          where: { machineClientId_scopeId: { machineClientId: runner.id, scopeId: iacScope.id } },
        }),
      () =>
        importIac(
          {
            workspace,
            kind: "scope",
            identity: manual.key,
            address: "scope.imported",
            operationId: randomUUID(),
          },
          iacActor,
        ),
    );
    await db.machineAllowedScope.create({
      data: { machineClientId: runner.id, scopeId: iacScope.id },
    });

    const binding = await db.iacObjectBinding.create({
      data: {
        workspaceId: workspace.id,
        address: "scope.bound",
        kind: "SCOPE",
        naturalIdentity: manual.key,
        scopeId: manual.id,
      },
    });
    const absent = parseDesiredState({ apiVersion: "weldall.dev/v1", workspace });
    await raceRevocation(
      (tx) => tx.machineClient.update({ where: { id: runner.id }, data: { enabled: false } }),
      () =>
        unmanageIac(
          {
            workspaceId: workspace.id,
            address: binding.address,
            manifest: absent,
            configDigest: digest(absent),
            operationId: randomUUID(),
          },
          iacActor,
        ),
    );
    await db.machineClient.update({ where: { id: runner.id }, data: { enabled: true } });

    await raceRevocation(
      (tx) =>
        tx.machineClientKey.update({
          where: { machineClientId_kid: { machineClientId: runner.id, kid: activeKey.kid } },
          data: { revokedAt: new Date(), revokedBy: actor.id },
        }),
      () =>
        moveIacState(
          {
            workspaceId: workspace.id,
            from: binding.address,
            to: "scope.moved",
            operationId: randomUUID(),
          },
          iacActor,
        ),
    );
    await db.machineClientKey.update({
      where: { machineClientId_kid: { machineClientId: runner.id, kid: activeKey.kid } },
      data: { revokedAt: null, revokedBy: null },
    });
    await expect(
      db.iacObjectBinding.findUnique({ where: { id: binding.id } }),
    ).resolves.toMatchObject({ address: "scope.bound" });
  });

  it("re-imports with a new operation ID after unmanage while retrying either import safely", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const iacActor: IacActor = {
      clientId: runner.clientId,
      keyId: runner.keys[0]!.kid,
      keyThumbprint: runner.keys[0]!.thumbprint,
      requestId: `${prefix}-import-lifecycle-request`,
    };
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-import-lifecycle`,
      issuer: "https://weldall.example.com",
    };
    const scope = await db.scope.create({
      data: {
        key: `${prefix}:reimport`,
        description: "Reimport",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    const firstRequest = {
      workspace,
      kind: "scope",
      identity: scope.key,
      address: "scope.reimported",
      operationId: randomUUID(),
    };
    const first = await importIac(firstRequest, iacActor);
    await expect(importIac(firstRequest, iacActor)).resolves.toEqual(first);
    const absent = parseDesiredState({ apiVersion: "weldall.dev/v1", workspace });
    await unmanageIac(
      {
        workspaceId: workspace.id,
        address: firstRequest.address,
        manifest: absent,
        configDigest: digest(absent),
        operationId: randomUUID(),
      },
      iacActor,
    );
    const secondRequest = { ...firstRequest, operationId: randomUUID() };
    const second = await importIac(secondRequest, iacActor);
    await expect(importIac(secondRequest, iacActor)).resolves.toEqual(second);
    expect(second.objectId).toBe(first.objectId);
    expect(second.revision).toBe(3);
    await expect(
      db.iacOperation.count({
        where: { workspaceId: workspace.id, type: "IMPORT", status: "SUCCEEDED" },
      }),
    ).resolves.toBe(2);
  });

  it("imports a machine whose client ID matches a protected scope key", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const workspace = {
      id: randomUUID(),
      name: `${prefix}-protected-name-import`,
      issuer: "https://weldall.example.com",
    };
    const machine = await db.machineClient.create({
      data: {
        clientId: IAC_SCOPE_KEY,
        name: "Machine named like the IaC scope",
        enabled: true,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });

    const imported = await importIac(
      {
        workspace,
        kind: "machine",
        identity: machine.clientId,
        address: "machine.scope_named",
        operationId: randomUUID(),
      },
      {
        clientId: runner.clientId,
        keyId: runner.keys[0]!.kid,
        keyThumbprint: runner.keys[0]!.thumbprint,
        requestId: `${prefix}-protected-name-import-request`,
      },
    );

    expect(imported).toMatchObject({
      objectId: machine.id,
      state: { clientId: IAC_SCOPE_KEY, name: machine.name },
    });
  });

  it("imports a group assignment with colons in its complete group ID", async () => {
    const runner = await db.machineClient.findUniqueOrThrow({
      where: { clientId: `${prefix}-apply-runner` },
      include: { keys: true },
    });
    const provider = await db.groupProvider.create({
      data: {
        key: `${prefix}-colon-provider`,
        name: "Colon group provider",
        adapterType: "management-api-v1",
        baseUrl: "https://colon-provider.example.com",
        encryptedToken: "test-token",
        encryptionKeyVersion: 1,
        enabled: true,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    const assignment = await db.groupScopeAssignment.create({
      data: {
        providerId: provider.id,
        groupId: "team:finance",
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });

    const imported = await importIac(
      {
        workspace: {
          id: randomUUID(),
          name: `${prefix}-colon-group-import`,
          issuer: "https://weldall.example.com",
        },
        kind: "groupAssignment",
        identity: `${provider.key}:${assignment.groupId}`,
        address: "groupAssignment.finance",
        operationId: randomUUID(),
      },
      {
        clientId: runner.clientId,
        keyId: runner.keys[0]!.kid,
        keyThumbprint: runner.keys[0]!.thumbprint,
        requestId: `${prefix}-colon-group-import-request`,
      },
    );

    expect(imported).toMatchObject({
      objectId: assignment.id,
      state: { provider: provider.key, groupId: "team:finance" },
    });
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
      apiVersion: "weldall.dev/v1",
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
      apiVersion: "weldall.dev/v1",
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
