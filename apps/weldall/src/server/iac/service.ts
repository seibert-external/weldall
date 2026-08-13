import { randomUUID } from "node:crypto";
import { db, IAC_SCOPE_KEY, Prisma } from "@weldall/db";
import { assertPublicP256 } from "@weldall/sdk";
import { calculateJwkThumbprint, type JWK } from "jose";
import {
  canonicalJson,
  digest,
  parseDesiredState,
  type DesiredState,
  type IacPlan,
} from "./contracts";
import { createPlan, desiredObjects, loadPlanningState } from "./planner";

export class IacError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export interface IacActor {
  clientId: string;
  keyId: string;
  keyThumbprint: string;
  requestId: string;
  correlationId?: string;
}

export async function getInstallation() {
  return db.iacInstallation.findUniqueOrThrow({ where: { id: "default" } });
}

export async function planIac(value: unknown): Promise<IacPlan> {
  const manifest = parseDesiredState(value);
  const state = await db.$transaction((tx) => loadPlanningState(tx, manifest));
  return createPlan(manifest, state);
}

export async function applyIac(
  input: {
    manifest: unknown;
    plannedRevision: number;
    configDigest: string;
    planDigest: string;
    operationId: string;
  },
  actor: IacActor,
) {
  const manifest = parseDesiredState(input.manifest);
  assertDigest(input.configDigest, digest(manifest), "CONFIG_DIGEST_MISMATCH");
  return db.$transaction(
    async (tx) => {
      await lockIacConfiguration(tx);
      const prior = await tx.iacOperation.findUnique({ where: { id: input.operationId } });
      if (prior) {
        if (prior.requestDigest !== digest(input))
          throw new IacError(
            "IDEMPOTENCY_CONFLICT",
            "Operation ID was used for a different request",
            409,
          );
        if (prior.status === "SUCCEEDED") return prior.resultSummary;
        throw new IacError("OPERATION_IN_PROGRESS", "Operation has not completed", 409);
      }
      const workspace = await ensureWorkspace(tx, manifest, actor.clientId);
      if (workspace.revision !== input.plannedRevision)
        throw new IacError("STALE_REVISION", "Workspace revision changed", 409, {
          currentRevision: workspace.revision,
        });
      const freshPlan = createPlan(manifest, await loadPlanningState(tx, manifest));
      assertDigest(input.planDigest, freshPlan.digest, "STALE_PLAN");
      if (freshPlan.blockers.length)
        throw new IacError("PLAN_BLOCKED", "Plan contains blockers", 409, {
          blockers: freshPlan.blockers,
        });
      await assertCallerSafe(tx, manifest, freshPlan, actor);
      await tx.iacOperation.create({
        data: {
          id: input.operationId,
          workspaceId: workspace.id,
          type: "APPLY",
          requestDigest: digest(input),
          priorRevision: workspace.revision,
        },
      });
      await executeDesiredState(tx, manifest, actor);
      const resultingRevision = workspace.revision + 1;
      const summary = {
        operationId: input.operationId,
        workspaceId: workspace.id,
        priorRevision: workspace.revision,
        resultingRevision,
        configDigest: freshPlan.configDigest,
        planDigest: freshPlan.digest,
        actions: freshPlan.actions.filter((action) => action.action !== "noop"),
      };
      await tx.iacWorkspace.update({
        where: { id: workspace.id },
        data: {
          revision: resultingRevision,
          lastConfigDigest: freshPlan.configDigest,
          lastActorId: actor.clientId,
        },
      });
      await tx.iacOperation.update({
        where: { id: input.operationId },
        data: {
          status: "SUCCEEDED",
          resultingRevision,
          resultSummary: JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonObject,
        },
      });
      await writeIacAudit(tx, actor, "iac.apply.succeeded", workspace, summary);
      return summary;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function executeDesiredState(
  tx: Prisma.TransactionClient,
  manifest: DesiredState,
  actor: IacActor,
) {
  const desired = desiredObjects(manifest);
  const desiredAddresses = new Set(desired.map((item) => item.address));
  const bindings = await tx.iacObjectBinding.findMany({
    where: { workspaceId: manifest.workspace.id },
  });
  for (const binding of bindings
    .filter((item) => !desiredAddresses.has(item.address))
    .sort((a, b) => b.address.localeCompare(a.address))) {
    await deleteBoundObject(tx, binding);
    await tx.iacObjectBinding.delete({ where: { id: binding.id } });
  }
  for (const item of desired) {
    const existing = bindings.find((binding) => binding.address === item.address);
    if (
      existing &&
      (fromDbKind(existing.kind) !== item.kind || existing.naturalIdentity !== item.identity)
    ) {
      await deleteBoundObject(tx, existing);
      await tx.iacObjectBinding.delete({ where: { id: existing.id } });
    }
    const binding =
      existing &&
      fromDbKind(existing.kind) === item.kind &&
      existing.naturalIdentity === item.identity
        ? existing
        : undefined;
    const objectId = await upsertObject(tx, item.kind, item.state as never, binding, actor);
    const target = bindingTarget(item.kind, objectId);
    if (binding) await tx.iacObjectBinding.update({ where: { id: binding.id }, data: target });
    else
      await tx.iacObjectBinding.create({
        data: {
          workspaceId: manifest.workspace.id,
          address: item.address,
          kind: toDbKind(item.kind),
          naturalIdentity: item.identity,
          ...target,
        },
      });
  }
}

async function upsertObject(
  tx: Prisma.TransactionClient,
  kind: ReturnType<typeof desiredObjects>[number]["kind"],
  state: any,
  binding: any,
  actor: IacActor,
): Promise<string> {
  if (kind === "scope") {
    const current = binding?.scopeId
      ? await tx.scope.findUnique({ where: { id: binding.scopeId } })
      : null;
    if (current)
      return (
        await tx.scope.update({
          where: { id: current.id },
          data: {
            description: state.description,
            version: { increment: 1 },
            updatedBy: actor.clientId,
          },
        })
      ).id;
    const collision = await tx.scope.findUnique({ where: { key: state.key } });
    if (collision) throw new IacError("MANUAL_COLLISION", `${state.key} must be imported`, 409);
    return (
      await tx.scope.create({
        data: {
          key: state.key,
          description: state.description,
          createdBy: actor.clientId,
          updatedBy: actor.clientId,
        },
      })
    ).id;
  }
  if (kind === "resource") {
    const scopes = await resolveScopes(tx, state.scopes);
    const current = binding?.resourceId
      ? await tx.downstreamResource.findUnique({ where: { id: binding.resourceId } })
      : null;
    if (!current && (await tx.downstreamResource.findUnique({ where: { key: state.key } })))
      throw new IacError("MANUAL_COLLISION", `${state.key} must be imported`, 409);
    const data = {
      name: state.name,
      authorizationServer: state.authorizationServer,
      downstreamClientId: state.downstreamClientId,
      enabled: state.enabled,
      skillDiscoveryEnabled: state.skillDiscoveryEnabled,
      updatedBy: actor.clientId,
    };
    const resource = current
      ? await tx.downstreamResource.update({
          where: { id: current.id },
          data: { ...data, version: { increment: 1 } },
        })
      : await tx.downstreamResource.create({
          data: {
            ...data,
            key: state.key,
            resourceIdentifier: state.resourceIdentifier,
            createdBy: actor.clientId,
          },
        });
    await tx.resourceScope.deleteMany({ where: { resourceId: resource.id } });
    if (scopes.length)
      await tx.resourceScope.createMany({
        data: scopes.map((scope) => ({ resourceId: resource.id, scopeId: scope.id })),
      });
    await tx.resourceRequestPrefix.deleteMany({ where: { resourceId: resource.id } });
    await tx.resourceRequestPrefix.createMany({
      data: state.requestPrefixes.map((urlPrefix: string) => ({
        resourceId: resource.id,
        urlPrefix,
        createdBy: actor.clientId,
      })),
    });
    return resource.id;
  }
  if (kind === "emailAssignment") {
    if (state.scopes.includes(IAC_SCOPE_KEY))
      throw new IacError("MACHINE_ONLY_SCOPE", `${IAC_SCOPE_KEY} cannot be granted to people`);
    const scopes = await resolveScopes(tx, state.scopes);
    const current = binding?.emailAssignmentId
      ? await tx.emailScopeAssignment.findUnique({ where: { id: binding.emailAssignmentId } })
      : null;
    if (
      !current &&
      (await tx.emailScopeAssignment.findUnique({ where: { normalizedEmail: state.email } }))
    )
      throw new IacError("MANUAL_COLLISION", `${state.email} must be imported`, 409);
    const assignment = current
      ? await tx.emailScopeAssignment.update({
          where: { id: current.id },
          data: { version: { increment: 1 }, updatedBy: actor.clientId },
        })
      : await tx.emailScopeAssignment.create({
          data: {
            normalizedEmail: state.email,
            createdBy: actor.clientId,
            updatedBy: actor.clientId,
          },
        });
    await tx.emailScopeGrant.deleteMany({ where: { assignmentId: assignment.id } });
    if (scopes.length)
      await tx.emailScopeGrant.createMany({
        data: scopes.map((scope) => ({
          id: randomUUID(),
          assignmentId: assignment.id,
          scopeId: scope.id,
          createdBy: actor.clientId,
        })),
      });
    return assignment.id;
  }
  if (kind === "groupAssignment") {
    if (state.scopes.includes(IAC_SCOPE_KEY))
      throw new IacError("MACHINE_ONLY_SCOPE", `${IAC_SCOPE_KEY} cannot be granted to people`);
    const [provider, scopes] = await Promise.all([
      tx.groupProvider.findUnique({ where: { key: state.provider } }),
      resolveScopes(tx, state.scopes),
    ]);
    if (!provider?.enabled)
      throw new IacError("INVALID_PROVIDER", `Provider ${state.provider} is unavailable`);
    const current = binding?.groupAssignmentId
      ? await tx.groupScopeAssignment.findUnique({ where: { id: binding.groupAssignmentId } })
      : null;
    if (
      !current &&
      (await tx.groupScopeAssignment.findUnique({
        where: { providerId_groupId: { providerId: provider.id, groupId: state.groupId } },
      }))
    )
      throw new IacError(
        "MANUAL_COLLISION",
        `${state.provider}:${state.groupId} must be imported`,
        409,
      );
    const assignment = current
      ? await tx.groupScopeAssignment.update({
          where: { id: current.id },
          data: { version: { increment: 1 }, updatedBy: actor.clientId },
        })
      : await tx.groupScopeAssignment.create({
          data: {
            providerId: provider.id,
            groupId: state.groupId,
            groupName: state.groupId,
            createdBy: actor.clientId,
            updatedBy: actor.clientId,
          },
        });
    await tx.groupScopeGrant.deleteMany({ where: { assignmentId: assignment.id } });
    if (scopes.length)
      await tx.groupScopeGrant.createMany({
        data: scopes.map((scope) => ({
          id: randomUUID(),
          assignmentId: assignment.id,
          scopeId: scope.id,
          createdBy: actor.clientId,
        })),
      });
    return assignment.id;
  }
  const current = binding?.machineClientId
    ? await tx.machineClient.findUnique({
        where: { id: binding.machineClientId },
        include: { keys: true },
      })
    : null;
  if (!current && (await tx.machineClient.findUnique({ where: { clientId: state.clientId } })))
    throw new IacError("MANUAL_COLLISION", `${state.clientId} must be imported`, 409);
  const machine = current
    ? await tx.machineClient.update({
        where: { id: current.id },
        data: {
          name: state.name,
          enabled: state.enabled,
          deactivatedAt: state.enabled ? null : new Date(),
          version: { increment: 1 },
          updatedBy: actor.clientId,
        },
      })
    : await tx.machineClient.create({
        data: {
          clientId: state.clientId,
          name: state.name,
          enabled: state.enabled,
          createdBy: actor.clientId,
          updatedBy: actor.clientId,
        },
      });
  const scopes = await resolveScopes(tx, state.scopes);
  const resources = await tx.downstreamResource.findMany({
    where: { key: { in: state.resources } },
  });
  if (resources.length !== state.resources.length)
    throw new IacError("UNKNOWN_REFERENCE", "Unknown machine resource reference");
  await tx.machineAllowedScope.deleteMany({ where: { machineClientId: machine.id } });
  await tx.machineAllowedResource.deleteMany({ where: { machineClientId: machine.id } });
  if (scopes.length)
    await tx.machineAllowedScope.createMany({
      data: scopes.map((scope) => ({ machineClientId: machine.id, scopeId: scope.id })),
    });
  if (resources.length)
    await tx.machineAllowedResource.createMany({
      data: resources.map((resource) => ({ machineClientId: machine.id, resourceId: resource.id })),
    });
  for (const [kid, value] of Object.entries(state.publicKeys) as Array<[string, JWK]>) {
    if ("d" in value)
      throw new IacError("PRIVATE_KEY_REJECTED", "Private JWK material is forbidden");
    await assertPublicP256(value);
    const thumbprint = await calculateJwkThumbprint(value, "sha256");
    const prior = current?.keys.find((key) => key.kid === kid);
    if (prior?.revokedAt)
      throw new IacError("KEY_REVOKED", `Revoked key ${kid} cannot be reactivated`, 409);
    if (!prior)
      await tx.machineClientKey.create({
        data: {
          machineClientId: machine.id,
          kid,
          publicJwk: value as Prisma.InputJsonObject,
          thumbprint,
          createdBy: actor.clientId,
        },
      });
  }
  for (const prior of current?.keys ?? [])
    if (!prior.revokedAt && !(prior.kid in state.publicKeys))
      await tx.machineClientKey.update({
        where: { id: prior.id },
        data: { revokedAt: new Date(), revokedBy: actor.clientId },
      });
  return machine.id;
}

export async function importIac(
  input: {
    workspace: DesiredState["workspace"];
    kind: string;
    identity: string;
    address: string;
    operationId: string;
  },
  actor: IacActor,
) {
  if (["weldall:login", "weldall:administer", IAC_SCOPE_KEY].includes(input.identity))
    throw new IacError("SYSTEM_SCOPE", "System scopes cannot be imported");
  return db.$transaction(
    async (tx) => {
      await lockIacConfiguration(tx);
      const manifest = parseDesiredState({
        apiVersion: "weldall.dev/v1alpha1",
        workspace: input.workspace,
      });
      const workspace = await ensureWorkspace(tx, manifest, actor.clientId);
      const found = await findNatural(tx, input.kind, input.identity);
      if (!found) throw new IacError("NOT_FOUND", "Primitive not found", 404);
      if (found.owned)
        throw new IacError("OWNED", "Primitive is already owned", 409, {
          ownerWorkspaceId: found.owned,
        });
      await tx.iacObjectBinding.create({
        data: {
          workspaceId: workspace.id,
          address: input.address,
          kind: toDbKind(input.kind as any),
          naturalIdentity: input.identity,
          ...bindingTarget(input.kind as any, found.id),
        },
      });
      await tx.iacWorkspace.update({
        where: { id: workspace.id },
        data: { revision: { increment: 1 }, lastActorId: actor.clientId },
      });
      return {
        workspaceId: workspace.id,
        address: input.address,
        objectId: found.id,
        state: found.state,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
export async function unmanageIac(
  input: { workspaceId: string; address: string; operationId: string },
  actor: IacActor,
) {
  return db.$transaction(
    async (tx) => {
      await lockIacConfiguration(tx);
      const binding = await tx.iacObjectBinding.findUnique({
        where: { workspaceId_address: { workspaceId: input.workspaceId, address: input.address } },
      });
      if (!binding) throw new IacError("NOT_FOUND", "Binding not found", 404);
      await tx.iacObjectBinding.delete({ where: { id: binding.id } });
      const workspace = await tx.iacWorkspace.update({
        where: { id: input.workspaceId },
        data: { revision: { increment: 1 }, lastActorId: actor.clientId },
      });
      return { workspaceId: workspace.id, address: input.address, revision: workspace.revision };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
export async function moveIacState(
  input: { workspaceId: string; from: string; to: string; operationId: string },
  actor: IacActor,
) {
  return db.$transaction(
    async (tx) => {
      await lockIacConfiguration(tx);
      const binding = await tx.iacObjectBinding.findUnique({
        where: { workspaceId_address: { workspaceId: input.workspaceId, address: input.from } },
      });
      if (!binding) throw new IacError("NOT_FOUND", "Binding not found", 404);
      await tx.iacObjectBinding.update({ where: { id: binding.id }, data: { address: input.to } });
      const workspace = await tx.iacWorkspace.update({
        where: { id: input.workspaceId },
        data: { revision: { increment: 1 }, lastActorId: actor.clientId },
      });
      return {
        workspaceId: workspace.id,
        from: input.from,
        to: input.to,
        revision: workspace.revision,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
export async function getIacState(workspaceId: string) {
  const workspace = await db.iacWorkspace.findUnique({
    where: { id: workspaceId },
    include: { bindings: { orderBy: { address: "asc" } } },
  });
  if (!workspace) throw new IacError("NOT_FOUND", "Workspace not found", 404);
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      issuer: workspace.issuer,
      revision: workspace.revision,
      lastConfigDigest: workspace.lastConfigDigest,
      updatedAt: workspace.updatedAt.toISOString(),
    },
    objects: workspace.bindings.map((item) => ({
      address: item.address,
      kind: fromDbKind(item.kind),
      identity: item.naturalIdentity,
      objectId:
        item.scopeId ??
        item.resourceId ??
        item.machineClientId ??
        item.emailAssignmentId ??
        item.groupAssignmentId,
      tombstone:
        !item.scopeId &&
        !item.resourceId &&
        !item.machineClientId &&
        !item.emailAssignmentId &&
        !item.groupAssignmentId,
    })),
  };
}

async function ensureWorkspace(
  tx: Prisma.TransactionClient,
  manifest: DesiredState,
  actorId: string,
) {
  const current = await tx.iacWorkspace.findUnique({ where: { id: manifest.workspace.id } });
  if (
    current &&
    (current.issuer !== manifest.workspace.issuer || current.name !== manifest.workspace.name)
  )
    throw new IacError("WORKSPACE_MISMATCH", "Workspace identity does not match", 409);
  return (
    current ?? tx.iacWorkspace.create({ data: { ...manifest.workspace, lastActorId: actorId } })
  );
}
async function resolveScopes(tx: Prisma.TransactionClient, keys: string[]) {
  const scopes = await tx.scope.findMany({ where: { key: { in: keys } } });
  if (scopes.length !== keys.length)
    throw new IacError("UNKNOWN_REFERENCE", "Unknown scope reference", 409);
  return scopes;
}
async function assertCallerSafe(
  tx: Prisma.TransactionClient,
  manifest: DesiredState,
  plan: IacPlan,
  actor: IacActor,
) {
  const desired = Object.values(manifest.machines).find(
    (machine) => machine.clientId === actor.clientId,
  );
  if (
    !desired ||
    !desired.enabled ||
    !desired.scopes.includes(IAC_SCOPE_KEY) ||
    !(actor.keyId in desired.publicKeys) ||
    plan.actions.some(
      (item) =>
        item.kind === "machine" && item.identity === actor.clientId && item.action === "delete",
    )
  )
    throw new IacError(
      "CALLER_SELF_PROTECTION",
      "Apply would remove the caller's active IaC authorization",
      409,
    );
  const live = await tx.machineClient.findUnique({
    where: { clientId: actor.clientId },
    include: { keys: true, allowedScopes: { include: { scope: true } } },
  });
  if (
    !live?.enabled ||
    !live.keys.some(
      (key) => key.kid === actor.keyId && key.thumbprint === actor.keyThumbprint && !key.revokedAt,
    ) ||
    !live.allowedScopes.some(({ scope }) => scope.key === IAC_SCOPE_KEY)
  )
    throw new IacError("AUTHORIZATION_REVOKED", "Machine authorization is no longer active", 401);
}
async function deleteBoundObject(tx: Prisma.TransactionClient, binding: any) {
  if (binding.scopeId) await tx.scope.delete({ where: { id: binding.scopeId } });
  else if (binding.resourceId)
    await tx.downstreamResource.delete({ where: { id: binding.resourceId } });
  else if (binding.machineClientId)
    await tx.machineClient.delete({ where: { id: binding.machineClientId } });
  else if (binding.emailAssignmentId)
    await tx.emailScopeAssignment.delete({ where: { id: binding.emailAssignmentId } });
  else if (binding.groupAssignmentId)
    await tx.groupScopeAssignment.delete({ where: { id: binding.groupAssignmentId } });
}
async function lockIacConfiguration(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(49350618)`;
}
function assertDigest(received: string, expected: string, code: string) {
  if (received !== expected)
    throw new IacError(code, "Digest does not match canonical content", 409, { expected });
}
function toDbKind(kind: string): any {
  return (
    {
      scope: "SCOPE",
      resource: "RESOURCE",
      machine: "MACHINE",
      emailAssignment: "EMAIL_ASSIGNMENT",
      groupAssignment: "GROUP_ASSIGNMENT",
    } as any
  )[kind];
}
function fromDbKind(kind: string): any {
  return (
    {
      SCOPE: "scope",
      RESOURCE: "resource",
      MACHINE: "machine",
      EMAIL_ASSIGNMENT: "emailAssignment",
      GROUP_ASSIGNMENT: "groupAssignment",
    } as any
  )[kind];
}
function bindingTarget(kind: string, id: string) {
  return (
    {
      scope: { scopeId: id },
      resource: { resourceId: id },
      machine: { machineClientId: id },
      emailAssignment: { emailAssignmentId: id },
      groupAssignment: { groupAssignmentId: id },
    } as any
  )[kind];
}
async function findNatural(
  tx: Prisma.TransactionClient,
  kind: string,
  identity: string,
): Promise<any> {
  let row: any;
  if (kind === "scope") row = await tx.scope.findUnique({ where: { key: identity } });
  else if (kind === "resource")
    row = await tx.downstreamResource.findUnique({ where: { key: identity } });
  else if (kind === "machine")
    row = await tx.machineClient.findUnique({ where: { clientId: identity } });
  else if (kind === "emailAssignment")
    row = await tx.emailScopeAssignment.findUnique({
      where: { normalizedEmail: identity },
      include: { grants: { include: { scope: true } } },
    });
  else {
    const [provider, groupId] = identity.split(":", 2);
    if (!provider || !groupId) return null;
    const p = await tx.groupProvider.findUnique({ where: { key: provider } });
    if (p)
      row = await tx.groupScopeAssignment.findUnique({
        where: { providerId_groupId: { providerId: p.id, groupId } },
      });
  }
  if (!row) return null;
  const owned = await tx.iacObjectBinding.findFirst({
    where: {
      OR: [
        { scopeId: row.id },
        { resourceId: row.id },
        { machineClientId: row.id },
        { emailAssignmentId: row.id },
        { groupAssignmentId: row.id },
      ],
    },
  });
  return { id: row.id, owned: owned?.workspaceId, state: JSON.parse(canonicalJson(row)) };
}
async function writeIacAudit(
  tx: Prisma.TransactionClient,
  actor: IacActor,
  eventType: string,
  workspace: { id: string; name: string },
  summary: any,
) {
  await tx.auditEvent.create({
    data: {
      eventType,
      actorType: "machine",
      actorId: actor.clientId,
      clientId: actor.clientId,
      requestId: actor.requestId,
      ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
      outcome: "success",
      subjectType: "iac_workspace",
      subjectId: workspace.id,
      metadata: {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        priorRevision: summary.priorRevision,
        resultingRevision: summary.resultingRevision,
        configDigest: summary.configDigest,
        planDigest: summary.planDigest,
        actionCount: summary.actions.length,
        addresses: summary.actions.map((item: any) => item.address).slice(0, 200),
      },
    },
  });
}
