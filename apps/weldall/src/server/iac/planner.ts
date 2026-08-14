import type { Prisma } from "@weldall/db";
import {
  canonicalJson,
  digest,
  type DesiredState,
  type IacAction,
  type IacBlocker,
  type IacKind,
  type IacPlan,
  publicKeySummary,
} from "./contracts";

export interface CurrentObject {
  address?: string;
  kind: IacKind;
  id: string;
  identity: string;
  version: number;
  ownerWorkspaceId?: string;
  state: unknown;
  tombstone?: boolean;
}

export interface PlanningState {
  revision: number;
  objects: CurrentObject[];
  externalBlockers?: IacBlocker[];
}

export function desiredObjects(manifest: DesiredState): Array<{
  address: string;
  kind: IacKind;
  identity: string;
  state: unknown;
}> {
  return [
    ...Object.entries(manifest.scopes).map(([name, state]) => ({
      address: `scope.${name}`,
      kind: "scope" as const,
      identity: state.key,
      state,
    })),
    ...Object.entries(manifest.resources).map(([name, state]) => ({
      address: `resource.${name}`,
      kind: "resource" as const,
      identity: state.key,
      state,
    })),
    ...Object.entries(manifest.machines).map(([name, state]) => ({
      address: `machine.${name}`,
      kind: "machine" as const,
      identity: state.clientId,
      state,
    })),
    ...Object.entries(manifest.skills).map(([name, state]) => ({
      address: `skill.${name}`,
      kind: "skill" as const,
      identity: state.slug,
      state,
    })),
    ...Object.entries(manifest.emailAssignments).map(([name, state]) => ({
      address: `emailAssignment.${name}`,
      kind: "emailAssignment" as const,
      identity: state.email,
      state,
    })),
    ...Object.entries(manifest.groupAssignments).map(([name, state]) => ({
      address: `groupAssignment.${name}`,
      kind: "groupAssignment" as const,
      identity: `${state.provider}:${state.groupId}`,
      state,
    })),
  ].sort((left, right) => left.address.localeCompare(right.address));
}

export function createPlan(manifest: DesiredState, current: PlanningState): IacPlan {
  const configDigest = digest(manifest);
  const desired = desiredObjects(manifest);
  const byAddress = new Map(
    current.objects
      .filter((object) => object.address && object.ownerWorkspaceId === manifest.workspace.id)
      .map((object) => [object.address!, object]),
  );
  const byNatural = new Map(
    current.objects.map((object) => [`${object.kind}:${object.identity}`, object]),
  );
  const actions: IacAction[] = [];
  const blockers: IacBlocker[] = [...(current.externalBlockers ?? [])];

  for (const object of desired) {
    const bound = byAddress.get(object.address);
    if (bound) {
      const immutableResourceChange =
        object.kind === "resource" &&
        !bound.tombstone &&
        (bound.state as { resourceIdentifier?: string }).resourceIdentifier !==
          (object.state as { resourceIdentifier?: string }).resourceIdentifier;
      if (
        bound.kind !== object.kind ||
        bound.identity !== object.identity ||
        immutableResourceChange
      ) {
        const collision = current.objects.find(
          (candidate) =>
            !candidate.tombstone &&
            candidate.id !== bound.id &&
            candidate.kind === object.kind &&
            candidate.identity === object.identity,
        );
        if (collision) blockers.push(collisionBlocker(object, collision, manifest.workspace.id));
        else actions.push(actionFor(object, "replace", bound));
      } else if (bound.tombstone) {
        const collision = current.objects.find(
          (candidate) =>
            !candidate.tombstone &&
            candidate.id !== bound.id &&
            candidate.kind === object.kind &&
            candidate.identity === object.identity,
        );
        if (collision) blockers.push(collisionBlocker(object, collision, manifest.workspace.id));
        else actions.push({ ...actionFor(object, "recreate"), drift: true });
      } else if (canonicalJson(bound.state) !== canonicalJson(object.state)) {
        if (object.kind === "machine") {
          const before = (bound.state as { publicKeys?: Record<string, any> }).publicKeys ?? {};
          const after = (object.state as { publicKeys?: Record<string, any> }).publicKeys ?? {};
          for (const kid of Object.keys(after)
            .filter((key) => !(key in before))
            .sort()) {
            const summary = publicKeySummary(kid, after[kid]);
            actions.push({
              address: object.address,
              kind: "machine",
              identity: object.identity,
              action: "register_key",
              observedVersion: bound.version,
              keyId: summary.kid,
              keyThumbprint: summary.thumbprint,
            });
          }
          for (const kid of Object.keys(before)
            .filter((key) => !(key in after))
            .sort()) {
            const summary = publicKeySummary(kid, before[kid]);
            actions.push({
              address: object.address,
              kind: "machine",
              identity: object.identity,
              action: "revoke_key",
              observedVersion: bound.version,
              irreversible: true,
              keyId: summary.kid,
              keyThumbprint: summary.thumbprint,
            });
          }
        }
        actions.push({ ...actionFor(object, "update", bound), drift: true });
      } else actions.push(actionFor(object, "noop", bound));
      continue;
    }
    const collision = byNatural.get(`${object.kind}:${object.identity}`);
    if (collision) blockers.push(collisionBlocker(object, collision, manifest.workspace.id));
    else actions.push(actionFor(object, "create"));
  }

  const desiredAddresses = new Set(desired.map((object) => object.address));
  for (const existing of current.objects
    .filter((object) => object.ownerWorkspaceId === manifest.workspace.id && object.address)
    .sort((left, right) => right.address!.localeCompare(left.address!))) {
    if (!desiredAddresses.has(existing.address!)) {
      actions.push({
        address: existing.address!,
        kind: existing.kind,
        identity: existing.identity,
        action: "delete",
        ...(!existing.tombstone ? { observedVersion: existing.version } : {}),
      });
    }
  }
  const orderedActions = actions.sort(compareActions);
  const planWithoutDigest = {
    version: 1 as const,
    workspaceId: manifest.workspace.id,
    revision: current.revision,
    configDigest,
    actions: orderedActions,
    blockers: blockers.sort((left, right) =>
      `${left.address ?? ""}:${left.code}`.localeCompare(`${right.address ?? ""}:${right.code}`),
    ),
  };
  return { ...planWithoutDigest, digest: digest(planWithoutDigest) };
}

function actionFor(
  object: { address: string; kind: IacKind; identity: string },
  action: IacAction["action"],
  observed?: CurrentObject,
): IacAction {
  return {
    address: object.address,
    kind: object.kind,
    identity: object.identity,
    action,
    ...(observed && !observed.tombstone ? { observedVersion: observed.version } : {}),
  };
}

function collisionBlocker(
  object: { address: string; identity: string },
  collision: CurrentObject,
  workspaceId: string,
): IacBlocker {
  const ownedByOther =
    collision.ownerWorkspaceId !== undefined && collision.ownerWorkspaceId !== workspaceId;
  return {
    code: ownedByOther ? "OWNED_BY_OTHER_WORKSPACE" : "MANUAL_COLLISION",
    address: object.address,
    message: ownedByOther
      ? `${object.identity} is owned by another workspace`
      : `${object.identity} already exists; import it explicitly`,
    ...(ownedByOther ? { ownerWorkspaceId: collision.ownerWorkspaceId } : {}),
  };
}

const actionRank: Record<IacAction["action"], number> = {
  create: 1,
  recreate: 1,
  register_key: 2,
  update: 3,
  replace: 4,
  revoke_key: 5,
  delete: 6,
  noop: 7,
};
const kindRank: Record<IacKind, number> = {
  scope: 1,
  resource: 2,
  machine: 3,
  emailAssignment: 4,
  groupAssignment: 4,
  skill: 2,
};
function compareActions(left: IacAction, right: IacAction): number {
  const action = actionRank[left.action] - actionRank[right.action];
  if (action) return action;
  const kind = kindRank[left.kind] - kindRank[right.kind];
  // Delete dependants before the primitives they reference.
  const dependency = left.action === "delete" ? -kind : kind;
  return (
    dependency ||
    left.address.localeCompare(right.address) ||
    (left.keyId ?? "").localeCompare(right.keyId ?? "")
  );
}

export async function loadPlanningState(
  tx: Prisma.TransactionClient,
  manifest: DesiredState,
): Promise<PlanningState> {
  const workspace = await tx.iacWorkspace.findUnique({ where: { id: manifest.workspace.id } });
  const [bindings, scopes, resources, machines, emails, groups, skills] = await Promise.all([
    tx.iacObjectBinding.findMany({ include: { workspace: true } }),
    tx.scope.findMany(),
    tx.downstreamResource.findMany({
      include: { scopes: { include: { scope: true } }, requestPrefixes: true },
    }),
    tx.machineClient.findMany({
      include: {
        keys: true,
        allowedResources: { include: { resource: true } },
        allowedScopes: { include: { scope: true } },
      },
    }),
    tx.emailScopeAssignment.findMany({ include: { grants: { include: { scope: true } } } }),
    tx.groupScopeAssignment.findMany({
      include: { provider: true, grants: { include: { scope: true } } },
    }),
    tx.skill.findMany(),
  ]);
  const bindingTargets = new Map<string, (typeof bindings)[number]>();
  for (const binding of bindings) {
    for (const id of [
      binding.scopeId,
      binding.resourceId,
      binding.machineClientId,
      binding.emailAssignmentId,
      binding.groupAssignmentId,
      binding.skillId,
    ])
      if (id) bindingTargets.set(id, binding);
  }
  const ownership = (id: string) => bindingTargets.get(id);
  const objects: CurrentObject[] = [
    ...scopes.map((item) => ({
      kind: "scope" as const,
      id: item.id,
      identity: item.key,
      version: item.version,
      state: { key: item.key, description: item.description },
      ...bindingInfo(ownership(item.id)),
    })),
    ...resources.map((item) => ({
      kind: "resource" as const,
      id: item.id,
      identity: item.key,
      version: item.version,
      state: {
        key: item.key,
        name: item.name,
        resourceIdentifier: item.resourceIdentifier,
        authorizationServer: item.authorizationServer,
        downstreamClientId: item.downstreamClientId,
        enabled: item.enabled,
        skillDiscoveryEnabled: item.skillDiscoveryEnabled,
        requestPrefixes: item.requestPrefixes.map((entry) => entry.urlPrefix).sort(),
        scopes: item.scopes.map((entry) => entry.scope.key).sort(),
      },
      ...bindingInfo(ownership(item.id)),
    })),
    ...machines.map((item) => ({
      kind: "machine" as const,
      id: item.id,
      identity: item.clientId,
      version: item.version,
      state: {
        clientId: item.clientId,
        name: item.name,
        enabled: item.enabled,
        publicKeys: Object.fromEntries(
          item.keys.filter((key) => !key.revokedAt).map((key) => [key.kid, key.publicJwk]),
        ),
        resources: item.allowedResources.map((entry) => entry.resource.key).sort(),
        scopes: item.allowedScopes.map((entry) => entry.scope.key).sort(),
      },
      ...bindingInfo(ownership(item.id)),
    })),
    ...emails.map((item) => ({
      kind: "emailAssignment" as const,
      id: item.id,
      identity: item.normalizedEmail,
      version: item.version,
      state: {
        email: item.normalizedEmail,
        scopes: item.grants.map((entry) => entry.scope.key).sort(),
      },
      ...bindingInfo(ownership(item.id)),
    })),
    ...groups.map((item) => ({
      kind: "groupAssignment" as const,
      id: item.id,
      identity: `${item.provider.key}:${item.groupId}`,
      version: item.version,
      state: {
        provider: item.provider.key,
        groupId: item.groupId,
        scopes: item.grants.map((entry) => entry.scope.key).sort(),
      },
      ...bindingInfo(ownership(item.id)),
    })),
    ...skills.map((item) => ({
      kind: "skill" as const,
      id: item.id,
      identity: item.slug,
      version: item.version,
      state: {
        slug: item.slug,
        title: item.title,
        content: item.content,
        requiredScopes: [...item.requiredScopes].sort(),
        visibility: item.visibility,
      },
      ...bindingInfo(ownership(item.id)),
    })),
  ];
  for (const binding of bindings.filter(
    (item) =>
      !item.scopeId &&
      !item.resourceId &&
      !item.machineClientId &&
      !item.emailAssignmentId &&
      !item.groupAssignmentId &&
      !item.skillId,
  )) {
    objects.push({
      address: binding.address,
      kind: fromPrismaKind(binding.kind),
      id: binding.id,
      identity: binding.naturalIdentity,
      version: 0,
      ownerWorkspaceId: binding.workspaceId,
      state: null,
      tombstone: true,
    });
  }
  const desired = desiredObjects(manifest);
  const desiredByAddress = new Map(desired.map((object) => [object.address, object]));
  const deletingAddresses = new Set(
    objects
      .filter((object) => {
        if (object.ownerWorkspaceId !== manifest.workspace.id || !object.address) return false;
        const desiredObject = desiredByAddress.get(object.address);
        return (
          !desiredObject ||
          desiredObject.kind !== object.kind ||
          desiredObject.identity !== object.identity ||
          (object.kind === "resource" &&
            !object.tombstone &&
            (object.state as { resourceIdentifier?: string }).resourceIdentifier !==
              (desiredObject.state as { resourceIdentifier?: string }).resourceIdentifier)
        );
      })
      .map((object) => object.address!),
  );
  const bindingByTarget = new Map(objects.map((object) => [object.id, object]));
  const externalBlockers: IacBlocker[] = [];
  const addReferenceBlocker = (
    target: CurrentObject,
    sourceId: string,
    desiredReferencesTarget: (state: any) => boolean,
    message: string,
  ) => {
    if (!target.address || !deletingAddresses.has(target.address)) return;
    const source = bindingByTarget.get(sourceId);
    const desiredSource = source?.address ? desiredByAddress.get(source.address) : undefined;
    if (
      !source ||
      source.ownerWorkspaceId !== manifest.workspace.id ||
      !source.address ||
      (desiredSource && desiredReferencesTarget(desiredSource.state))
    )
      externalBlockers.push({ code: "EXTERNAL_REFERENCE", address: target.address, message });
  };
  for (const resource of resources)
    for (const scope of resource.scopes) {
      const target = objects.find(
        (object) => object.kind === "scope" && object.id === scope.scopeId,
      );
      if (target)
        addReferenceBlocker(
          target,
          resource.id,
          (state) => state.scopes.includes(target.identity),
          `Scope ${target.identity} is referenced by resource ${resource.key}`,
        );
    }
  for (const machine of machines) {
    for (const scope of machine.allowedScopes) {
      const target = objects.find(
        (object) => object.kind === "scope" && object.id === scope.scopeId,
      );
      if (target)
        addReferenceBlocker(
          target,
          machine.id,
          (state) => state.scopes.includes(target.identity),
          `Scope ${target.identity} is referenced by machine ${machine.clientId}`,
        );
    }
    for (const resource of machine.allowedResources) {
      const target = objects.find(
        (object) => object.kind === "resource" && object.id === resource.resourceId,
      );
      if (target)
        addReferenceBlocker(
          target,
          machine.id,
          (state) => state.resources.includes(target.identity),
          `Resource ${target.identity} is referenced by machine ${machine.clientId}`,
        );
    }
  }
  for (const email of emails)
    for (const grant of email.grants) {
      const target = objects.find(
        (object) => object.kind === "scope" && object.id === grant.scopeId,
      );
      if (target)
        addReferenceBlocker(
          target,
          email.id,
          (state) => state.scopes.includes(target.identity),
          `Scope ${target.identity} is referenced by email assignment ${email.normalizedEmail}`,
        );
    }
  for (const group of groups)
    for (const grant of group.grants) {
      const target = objects.find(
        (object) => object.kind === "scope" && object.id === grant.scopeId,
      );
      if (target)
        addReferenceBlocker(
          target,
          group.id,
          (state) => state.scopes.includes(target.identity),
          `Scope ${target.identity} is referenced by group assignment ${group.provider.key}:${group.groupId}`,
        );
    }
  for (const skill of skills)
    for (const key of skill.requiredScopes) {
      const target = objects.find((object) => object.kind === "scope" && object.identity === key);
      if (target)
        addReferenceBlocker(
          target,
          skill.id,
          (state) => state.requiredScopes.includes(target.identity),
          `Scope ${key} is referenced by skill ${skill.slug}`,
        );
    }
  return { revision: workspace?.revision ?? 0, objects, externalBlockers };
}

function bindingInfo(binding: { address: string; workspaceId: string } | undefined) {
  return binding ? { address: binding.address, ownerWorkspaceId: binding.workspaceId } : {};
}
function fromPrismaKind(kind: string): IacKind {
  return (
    {
      SCOPE: "scope",
      RESOURCE: "resource",
      MACHINE: "machine",
      EMAIL_ASSIGNMENT: "emailAssignment",
      GROUP_ASSIGNMENT: "groupAssignment",
      SKILL: "skill",
    } as Record<string, IacKind>
  )[kind]!;
}
