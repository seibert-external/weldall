import { db, IAC_SCOPE_KEY, Prisma } from "@weldall/db";
import { digest, parseDesiredState, type DesiredState, type IacPlan } from "./contracts";
import { createPlan, desiredObjects, loadPlanningState } from "./planner";
import { lockConfigurationChanges } from "../domain/configuration";
import {
  deleteMachine,
  mutateEmailAssignment,
  mutateGroupAssignment,
  mutateResource,
  mutateScope,
  preflightGroupAssignment,
  reconcileMachine,
  type GroupAssignmentPreflight,
  type MutationActor,
  PrimitiveMutationError,
} from "../domain/primitive-mutations";

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

export async function planIac(value: unknown, actor?: IacActor): Promise<IacPlan> {
  const manifest = parseDesiredState(value);
  const state = await db.$transaction((tx) => loadPlanningState(tx, manifest));
  const plan = createPlan(manifest, state);
  if (actor) {
    const workspace = await db.iacWorkspace.findUnique({ where: { id: manifest.workspace.id } });
    if (workspace)
      await writeIacAudit(db, actor, "iac.plan.generated", workspace, {
        priorRevision: plan.revision,
        resultingRevision: plan.revision,
        configDigest: plan.configDigest,
        planDigest: plan.digest,
        actions: plan.actions,
      });
  }
  return plan;
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
  try {
    assertDigest(input.configDigest, digest(manifest), "CONFIG_DIGEST_MISMATCH");
    const requestDigest = digest(input);
    const committed = await db.iacOperation.findUnique({ where: { id: input.operationId } });
    if (committed) {
      if (committed.requestDigest !== requestDigest)
        throw new IacError(
          "IDEMPOTENCY_CONFLICT",
          "Operation ID was used for a different request",
          409,
        );
      if (committed.status === "SUCCEEDED") return committed.resultSummary;
    }
    const groupPreflights = await preflightNewGroupAssignments(manifest);
    return await db.$transaction(
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
        await assertFinalAdministratorSafe(tx, manifest);
        await tx.iacOperation.create({
          data: {
            id: input.operationId,
            workspaceId: workspace.id,
            type: "APPLY",
            requestDigest: digest(input),
            priorRevision: workspace.revision,
          },
        });
        await executeDesiredState(tx, manifest, actor, groupPreflights);
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
  } catch (error) {
    const mapped =
      error instanceof PrimitiveMutationError
        ? new IacError(
            error.code,
            error.message,
            error.code === "NOT_FOUND" ? 404 : 409,
            error.details,
          )
        : error;
    await writeIacOutcomeAudit(db, actor, manifest.workspace, input, mapped);
    throw mapped;
  }
}

async function executeDesiredState(
  tx: Prisma.TransactionClient,
  manifest: DesiredState,
  actor: IacActor,
  groupPreflights: ReadonlyMap<string, GroupAssignmentPreflight>,
) {
  const desired = desiredObjects(manifest);
  const desiredAddresses = new Set(desired.map((item) => item.address));
  const bindings = await tx.iacObjectBinding.findMany({
    where: { workspaceId: manifest.workspace.id },
  });
  for (const binding of bindings
    .filter((item) => !desiredAddresses.has(item.address))
    .sort(compareBindingDeletes)) {
    await deleteBoundObject(tx, binding, mutationActor(actor));
    await tx.iacObjectBinding.delete({ where: { id: binding.id } });
  }
  for (const item of desired) {
    const existing = bindings.find((binding) => binding.address === item.address);
    if (
      existing &&
      (fromDbKind(existing.kind) !== item.kind || existing.naturalIdentity !== item.identity)
    ) {
      await deleteBoundObject(tx, existing, mutationActor(actor));
      await tx.iacObjectBinding.delete({ where: { id: existing.id } });
    }
    const binding =
      existing &&
      fromDbKind(existing.kind) === item.kind &&
      existing.naturalIdentity === item.identity
        ? existing
        : undefined;
    const objectId = await upsertObject(
      tx,
      item.kind,
      item.state as never,
      binding,
      actor,
      groupPreflights.get(item.address),
    );
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
  groupPreflight?: GroupAssignmentPreflight,
): Promise<string> {
  const mutation = mutationActor(actor);
  if (kind === "scope") {
    const current = binding?.scopeId
      ? await tx.scope.findUnique({ where: { id: binding.scopeId } })
      : null;
    if (!current && (await tx.scope.findUnique({ where: { key: state.key } })))
      throw new IacError("MANUAL_COLLISION", `${state.key} must be imported`, 409);
    return (
      await mutateScope(
        tx,
        current
          ? {
              action: "update",
              id: current.id,
              description: state.description,
              expectedVersion: current.version,
            }
          : { action: "create", key: state.key, description: state.description },
        mutation,
      )
    ).id;
  }
  if (kind === "resource") {
    const current = binding?.resourceId
      ? await tx.downstreamResource.findUnique({ where: { id: binding.resourceId } })
      : null;
    if (!current && (await tx.downstreamResource.findUnique({ where: { key: state.key } })))
      throw new IacError("MANUAL_COLLISION", `${state.key} must be imported`, 409);
    const common = {
      name: state.name,
      authorizationServer: state.authorizationServer,
      downstreamClientId: state.downstreamClientId,
      enabled: state.enabled,
      skillDiscoveryEnabled: state.skillDiscoveryEnabled,
      scopeKeys: state.scopes,
      requestPrefixes: state.requestPrefixes,
    };
    return (
      await mutateResource(
        tx,
        current
          ? { action: "update", id: current.id, expectedVersion: current.version, ...common }
          : {
              action: "create",
              key: state.key,
              resourceIdentifier: state.resourceIdentifier,
              ...common,
            },
        mutation,
      )
    ).id;
  }
  if (kind === "emailAssignment") {
    const current = binding?.emailAssignmentId
      ? await tx.emailScopeAssignment.findUnique({ where: { id: binding.emailAssignmentId } })
      : null;
    if (
      !current &&
      (await tx.emailScopeAssignment.findUnique({ where: { normalizedEmail: state.email } }))
    )
      throw new IacError("MANUAL_COLLISION", `${state.email} must be imported`, 409);
    const assignment = await mutateEmailAssignment(
      tx,
      { email: state.email, scopeKeys: state.scopes, expectedVersion: current?.version ?? null },
      mutation,
    );
    if (!assignment)
      throw new IacError("INVALID_ASSIGNMENT", "An IaC assignment must contain a scope");
    return assignment.id;
  }
  if (kind === "groupAssignment") {
    const current = binding?.groupAssignmentId
      ? await tx.groupScopeAssignment.findUnique({ where: { id: binding.groupAssignmentId } })
      : null;
    if (current)
      return (
        await mutateGroupAssignment(
          tx,
          {
            action: "update",
            id: current.id,
            scopeKeys: state.scopes,
            expectedVersion: current.version,
          },
          mutation,
        )
      ).id;
    if (!groupPreflight)
      throw new IacError("GROUP_PREFLIGHT_REQUIRED", "New group assignment was not validated", 409);
    return (
      await mutateGroupAssignment(
        tx,
        {
          action: "create",
          providerKey: state.provider,
          groupId: state.groupId,
          scopeKeys: state.scopes,
          preflight: groupPreflight,
        },
        mutation,
      )
    ).id;
  }
  const current = binding?.machineClientId
    ? await tx.machineClient.findUnique({ where: { id: binding.machineClientId } })
    : null;
  if (!current && (await tx.machineClient.findUnique({ where: { clientId: state.clientId } })))
    throw new IacError("MANUAL_COLLISION", `${state.clientId} must be imported`, 409);
  return (
    await reconcileMachine(
      tx,
      {
        ...(current ? { id: current.id } : {}),
        clientId: state.clientId,
        name: state.name,
        enabled: state.enabled,
        resourceKeys: state.resources,
        scopeKeys: state.scopes,
        publicKeys: state.publicKeys,
        expectedVersion: current?.version ?? null,
      },
      mutation,
    )
  ).id;
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
      const replay = await beginOperation(tx, workspace, "IMPORT", input);
      if (replay) return replay;
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
      const updated = await tx.iacWorkspace.update({
        where: { id: workspace.id },
        data: { revision: { increment: 1 }, lastActorId: actor.clientId },
      });
      const result = {
        workspaceId: workspace.id,
        address: input.address,
        objectId: found.id,
        state: found.state,
        revision: updated.revision,
      };
      await completeOperation(tx, input.operationId, updated.revision, result);
      await writeIacAudit(
        tx,
        actor,
        "iac.object.imported",
        workspace,
        lifecycleSummary(workspace.revision, updated.revision, input.address),
      );
      return result;
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
      const workspaceBefore = await tx.iacWorkspace.findUnique({
        where: { id: input.workspaceId },
      });
      if (!workspaceBefore) throw new IacError("NOT_FOUND", "Workspace not found", 404);
      const replay = await beginOperation(tx, workspaceBefore, "UNMANAGE", input);
      if (replay) return replay;
      const binding = await tx.iacObjectBinding.findUnique({
        where: { workspaceId_address: { workspaceId: input.workspaceId, address: input.address } },
      });
      if (!binding) throw new IacError("NOT_FOUND", "Binding not found", 404);
      await tx.iacObjectBinding.delete({ where: { id: binding.id } });
      const workspace = await tx.iacWorkspace.update({
        where: { id: input.workspaceId },
        data: { revision: { increment: 1 }, lastActorId: actor.clientId },
      });
      const result = {
        workspaceId: workspace.id,
        address: input.address,
        revision: workspace.revision,
      };
      await completeOperation(tx, input.operationId, workspace.revision, result);
      await writeIacAudit(
        tx,
        actor,
        "iac.object.unmanaged",
        workspace,
        lifecycleSummary(workspaceBefore.revision, workspace.revision, input.address),
      );
      return result;
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
      const workspaceBefore = await tx.iacWorkspace.findUnique({
        where: { id: input.workspaceId },
      });
      if (!workspaceBefore) throw new IacError("NOT_FOUND", "Workspace not found", 404);
      const replay = await beginOperation(tx, workspaceBefore, "STATE_MOVE", input);
      if (replay) return replay;
      const binding = await tx.iacObjectBinding.findUnique({
        where: { workspaceId_address: { workspaceId: input.workspaceId, address: input.from } },
      });
      if (!binding) throw new IacError("NOT_FOUND", "Binding not found", 404);
      await tx.iacObjectBinding.update({ where: { id: binding.id }, data: { address: input.to } });
      const workspace = await tx.iacWorkspace.update({
        where: { id: input.workspaceId },
        data: { revision: { increment: 1 }, lastActorId: actor.clientId },
      });
      const result = {
        workspaceId: workspace.id,
        from: input.from,
        to: input.to,
        revision: workspace.revision,
      };
      await completeOperation(tx, input.operationId, workspace.revision, result);
      await writeIacAudit(
        tx,
        actor,
        "iac.state.moved",
        workspace,
        lifecycleSummary(workspaceBefore.revision, workspace.revision, input.to),
      );
      return result;
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
    objects: await Promise.all(
      workspace.bindings.map(async (item) => {
        const objectId =
          item.scopeId ??
          item.resourceId ??
          item.machineClientId ??
          item.emailAssignmentId ??
          item.groupAssignmentId;
        return {
          address: item.address,
          kind: fromDbKind(item.kind),
          identity: item.naturalIdentity,
          objectId,
          observedVersion: objectId ? await observedVersion(db, item) : 0,
          tombstone: !objectId,
        };
      }),
    ),
  };
}

async function beginOperation(
  tx: Prisma.TransactionClient,
  workspace: { id: string; revision: number },
  type: "IMPORT" | "UNMANAGE" | "STATE_MOVE",
  input: { operationId: string },
): Promise<any | null> {
  const requestDigest = digest(input);
  const prior = await tx.iacOperation.findUnique({ where: { id: input.operationId } });
  if (prior) {
    if (
      prior.workspaceId !== workspace.id ||
      prior.type !== type ||
      prior.requestDigest !== requestDigest
    )
      throw new IacError(
        "IDEMPOTENCY_CONFLICT",
        "Operation ID was used for a different request",
        409,
      );
    if (prior.status === "SUCCEEDED") return prior.resultSummary;
    throw new IacError("OPERATION_IN_PROGRESS", "Operation has not completed", 409);
  }
  await tx.iacOperation.create({
    data: {
      id: input.operationId,
      workspaceId: workspace.id,
      type,
      requestDigest,
      priorRevision: workspace.revision,
    },
  });
  return null;
}

async function completeOperation(
  tx: Prisma.TransactionClient,
  operationId: string,
  revision: number,
  result: Record<string, unknown>,
) {
  await tx.iacOperation.update({
    where: { id: operationId },
    data: {
      status: "SUCCEEDED",
      resultingRevision: revision,
      resultSummary: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonObject,
    },
  });
}

function lifecycleSummary(priorRevision: number, resultingRevision: number, address: string) {
  return { priorRevision, resultingRevision, actions: [{ address }] };
}

async function observedVersion(client: typeof db, binding: any): Promise<number> {
  if (binding.scopeId)
    return (
      await client.scope.findUniqueOrThrow({
        where: { id: binding.scopeId },
        select: { version: true },
      })
    ).version;
  if (binding.resourceId)
    return (
      await client.downstreamResource.findUniqueOrThrow({
        where: { id: binding.resourceId },
        select: { version: true },
      })
    ).version;
  if (binding.machineClientId)
    return (
      await client.machineClient.findUniqueOrThrow({
        where: { id: binding.machineClientId },
        select: { version: true },
      })
    ).version;
  if (binding.emailAssignmentId)
    return (
      await client.emailScopeAssignment.findUniqueOrThrow({
        where: { id: binding.emailAssignmentId },
        select: { version: true },
      })
    ).version;
  if (binding.groupAssignmentId)
    return (
      await client.groupScopeAssignment.findUniqueOrThrow({
        where: { id: binding.groupAssignmentId },
        select: { version: true },
      })
    ).version;
  return 0;
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
async function preflightNewGroupAssignments(manifest: DesiredState) {
  const bindings = await db.iacObjectBinding.findMany({
    where: { workspaceId: manifest.workspace.id, kind: "GROUP_ASSIGNMENT" },
    select: { address: true, groupAssignmentId: true },
  });
  const existing = new Map(bindings.map((binding) => [binding.address, binding.groupAssignmentId]));
  const entries = await Promise.all(
    Object.entries(manifest.groupAssignments)
      .filter(([name]) => !existing.get(`groupAssignment.${name}`))
      .map(
        async ([name, assignment]) =>
          [
            `groupAssignment.${name}`,
            await preflightGroupAssignment(assignment.provider, assignment.groupId),
          ] as const,
      ),
  );
  return new Map(entries);
}

function mutationActor(actor: IacActor): MutationActor {
  return {
    type: "machine",
    id: actor.clientId,
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    source: "weldall_up",
  };
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
  // A caller need not be owned by this workspace. Only validate desired final
  // state when this snapshot actually manages that machine.
  if (
    desired &&
    (!desired.enabled ||
      !desired.scopes.includes(IAC_SCOPE_KEY) ||
      !(actor.keyId in desired.publicKeys))
  )
    throw new IacError(
      "CALLER_SELF_PROTECTION",
      "Apply would remove the caller's active IaC authorization",
      409,
    );
  if (
    plan.actions.some(
      (item) =>
        item.kind === "machine" &&
        item.identity === actor.clientId &&
        (item.action === "delete" || (item.action === "revoke_key" && item.keyId === actor.keyId)),
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
async function assertFinalAdministratorSafe(tx: Prisma.TransactionClient, manifest: DesiredState) {
  const [users, assignments, bindings] = await Promise.all([
    tx.user.findMany({ where: { emailVerified: true }, select: { email: true } }),
    tx.emailScopeAssignment.findMany({
      where: { grants: { some: { scope: { key: "weldall:administer" } } } },
      select: { id: true, normalizedEmail: true },
    }),
    tx.iacObjectBinding.findMany({
      where: { workspaceId: manifest.workspace.id, kind: "EMAIL_ASSIGNMENT" },
      select: { emailAssignmentId: true, address: true },
    }),
  ]);
  const verified = new Set(users.map(({ email }) => email.trim().toLowerCase()));
  const finalAdmins = new Set(assignments.map(({ normalizedEmail }) => normalizedEmail));
  const desiredByAddress = new Map(
    Object.entries(manifest.emailAssignments).map(([name, item]) => [
      `emailAssignment.${name}`,
      item,
    ]),
  );
  for (const binding of bindings) {
    const current = assignments.find(({ id }) => id === binding.emailAssignmentId);
    if (current) finalAdmins.delete(current.normalizedEmail);
    const desired = desiredByAddress.get(binding.address);
    if (desired?.scopes.includes("weldall:administer")) finalAdmins.add(desired.email);
  }
  for (const [address, desired] of desiredByAddress) {
    if (
      !bindings.some((binding) => binding.address === address) &&
      desired.scopes.includes("weldall:administer")
    )
      finalAdmins.add(desired.email);
  }
  if (![...finalAdmins].some((email) => verified.has(email)))
    throw new IacError("LAST_ADMIN", "The last verified administrator cannot be removed", 409);
}

async function deleteBoundObject(tx: Prisma.TransactionClient, binding: any, actor: MutationActor) {
  if (binding.scopeId) {
    const current = await tx.scope.findUniqueOrThrow({ where: { id: binding.scopeId } });
    await mutateScope(
      tx,
      { action: "delete", id: current.id, expectedVersion: current.version },
      actor,
    );
  } else if (binding.resourceId) {
    const current = await tx.downstreamResource.findUniqueOrThrow({
      where: { id: binding.resourceId },
    });
    await mutateResource(
      tx,
      { action: "delete", id: current.id, expectedVersion: current.version },
      actor,
    );
  } else if (binding.machineClientId) {
    const current = await tx.machineClient.findUniqueOrThrow({
      where: { id: binding.machineClientId },
    });
    await deleteMachine(tx, { id: current.id, expectedVersion: current.version }, actor);
  } else if (binding.emailAssignmentId) {
    const current = await tx.emailScopeAssignment.findUniqueOrThrow({
      where: { id: binding.emailAssignmentId },
    });
    await mutateEmailAssignment(
      tx,
      { email: current.normalizedEmail, scopeKeys: [], expectedVersion: current.version },
      actor,
    );
  } else if (binding.groupAssignmentId) {
    const current = await tx.groupScopeAssignment.findUniqueOrThrow({
      where: { id: binding.groupAssignmentId },
    });
    await mutateGroupAssignment(
      tx,
      { action: "delete", id: current.id, expectedVersion: current.version },
      actor,
    );
  }
}

function compareBindingDeletes(left: any, right: any) {
  const rank: Record<string, number> = {
    GROUP_ASSIGNMENT: 1,
    EMAIL_ASSIGNMENT: 1,
    MACHINE: 2,
    RESOURCE: 3,
    SCOPE: 4,
  };
  return (
    (rank[left.kind] ?? 9) - (rank[right.kind] ?? 9) || right.address.localeCompare(left.address)
  );
}
async function lockIacConfiguration(tx: Prisma.TransactionClient) {
  await lockConfigurationChanges(tx);
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
    row = await tx.downstreamResource.findUnique({
      where: { key: identity },
      include: { scopes: { include: { scope: true } }, requestPrefixes: true },
    });
  else if (kind === "machine")
    row = await tx.machineClient.findUnique({
      where: { clientId: identity },
      include: {
        keys: true,
        allowedResources: { include: { resource: true } },
        allowedScopes: { include: { scope: true } },
      },
    });
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
        include: { provider: true, grants: { include: { scope: true } } },
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
  const state =
    kind === "scope"
      ? { key: row.key, description: row.description }
      : kind === "resource"
        ? {
            key: row.key,
            name: row.name,
            resourceIdentifier: row.resourceIdentifier,
            authorizationServer: row.authorizationServer,
            downstreamClientId: row.downstreamClientId,
            enabled: row.enabled,
            skillDiscoveryEnabled: row.skillDiscoveryEnabled,
            requestPrefixes: row.requestPrefixes.map((item: any) => item.urlPrefix).sort(),
            scopes: row.scopes.map((item: any) => item.scope.key).sort(),
          }
        : kind === "machine"
          ? {
              clientId: row.clientId,
              name: row.name,
              enabled: row.enabled,
              publicKeys: Object.fromEntries(
                row.keys
                  .filter((item: any) => !item.revokedAt)
                  .sort((a: any, b: any) => a.kid.localeCompare(b.kid))
                  .map((item: any) => [item.kid, item.publicJwk]),
              ),
              resources: row.allowedResources.map((item: any) => item.resource.key).sort(),
              scopes: row.allowedScopes.map((item: any) => item.scope.key).sort(),
            }
          : kind === "emailAssignment"
            ? {
                email: row.normalizedEmail,
                scopes: row.grants.map((item: any) => item.scope.key).sort(),
              }
            : {
                provider: row.provider.key,
                groupId: row.groupId,
                scopes: row.grants.map((item: any) => item.scope.key).sort(),
              };
  return { id: row.id, owned: owned?.workspaceId, state };
}
async function writeIacAudit(
  tx: Prisma.TransactionClient,
  actor: IacActor,
  eventType: string,
  workspace: { id: string; name: string },
  summary: any,
) {
  await tx.auditEvent.create({
    data: iacAuditData(actor, eventType, workspace, "success", summary),
  });
}

async function writeIacOutcomeAudit(
  client: typeof db,
  actor: IacActor,
  workspace: DesiredState["workspace"],
  input: {
    plannedRevision: number;
    configDigest: string;
    planDigest: string;
    operationId: string;
  },
  error: unknown,
) {
  const denied =
    error instanceof IacError &&
    ["AUTHORIZATION_REVOKED", "CALLER_SELF_PROTECTION", "LAST_ADMIN", "PLAN_BLOCKED"].includes(
      error.code,
    );
  const reasonCode = error instanceof IacError ? error.code.slice(0, 100) : "INTERNAL_ERROR";
  try {
    await client.auditEvent.create({
      data: iacAuditData(
        actor,
        denied ? "iac.apply.denied" : "iac.apply.failed",
        workspace,
        denied ? "denied" : "failed",
        {
          priorRevision: input.plannedRevision,
          resultingRevision: input.plannedRevision,
          configDigest: input.configDigest,
          planDigest: input.planDigest,
          actions: [],
          reasonCode,
          operationId: input.operationId,
        },
      ),
    });
  } catch {
    // The original apply error remains authoritative when the durable outcome
    // audit store itself is unavailable.
  }
}

function iacAuditData(
  actor: IacActor,
  eventType: string,
  workspace: { id: string; name: string },
  outcome: "success" | "denied" | "failed",
  summary: any,
): Prisma.AuditEventCreateInput {
  const actions = Array.isArray(summary.actions) ? summary.actions.slice(0, 200) : [];
  return {
    eventType,
    actorType: "machine",
    actorId: actor.clientId.slice(0, 128),
    clientId: actor.clientId.slice(0, 200),
    requestId: actor.requestId.slice(0, 128),
    ...(actor.correlationId ? { correlationId: actor.correlationId.slice(0, 128) } : {}),
    outcome,
    ...(outcome === "success" ? {} : { reasonCode: String(summary.reasonCode).slice(0, 100) }),
    subjectType: "iac_workspace",
    subjectId: workspace.id,
    metadata: {
      workspaceId: workspace.id,
      workspaceName: workspace.name.slice(0, 200),
      priorRevision: summary.priorRevision,
      resultingRevision: summary.resultingRevision,
      ...(summary.configDigest ? { configDigest: String(summary.configDigest).slice(0, 64) } : {}),
      ...(summary.planDigest ? { planDigest: String(summary.planDigest).slice(0, 64) } : {}),
      ...(summary.operationId ? { operationId: String(summary.operationId).slice(0, 128) } : {}),
      ...(summary.reasonCode ? { reasonCode: String(summary.reasonCode).slice(0, 100) } : {}),
      actionCount: actions.length,
      addresses: actions.map((item: any) => String(item.address).slice(0, 160)),
      keys: actions
        .filter((item: any) => item.keyId)
        .map((item: any) => ({
          keyId: String(item.keyId).slice(0, 128),
          thumbprint: String(item.keyThumbprint ?? "").slice(0, 100),
        })),
    },
  };
}
