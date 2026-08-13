import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { define } from "gunshi";
import { stringify } from "yaml";
import { CliError } from "../errors.js";
import { IacClient } from "./client.js";
import {
  loadWorkspace,
  MANIFEST_FILE,
  newLock,
  serverManifest,
  writeLock,
  type Lockfile,
} from "./manifest.js";

const jsonArgument = {
  type: "boolean",
  description: "Print stable machine-readable JSON",
} as const;
const yesArgument = {
  type: "boolean",
  description: "Approve without an interactive prompt",
} as const;
export const printPlan = (plan: any) => {
  for (const action of [...plan.actions]
    .filter((item: any) => item.action !== "noop")
    .sort((left: any, right: any) =>
      `${left.address}:${left.action}`.localeCompare(`${right.address}:${right.action}`),
    ))
    console.log(`${action.action.padEnd(12)} ${action.address} (${action.identity})`);
  for (const blocker of [...plan.blockers].sort((left: any, right: any) =>
    `${left.address ?? "workspace"}:${left.code ?? ""}`.localeCompare(
      `${right.address ?? "workspace"}:${right.code ?? ""}`,
    ),
  ))
    console.log(`blocked      ${blocker.address ?? "workspace"}: ${blocker.message}`);
  if (!plan.actions.some((item: any) => item.action !== "noop")) console.log("No changes.");
};
const lockWithDiscovery = (lock: Lockfile, installationId: string) => ({
  ...lock,
  server: { ...lock.server, installationId },
});
export const lockFromState = (lock: Lockfile, installationId: string, state: any): Lockfile => ({
  ...lockWithDiscovery(lock, installationId),
  workspace: {
    id: state.workspace.id,
    name: state.workspace.name,
    observedRevision: state.workspace.revision,
  },
  objects: Object.fromEntries(
    state.objects.map((item: any) => [
      item.address,
      {
        kind: item.kind,
        objectId: item.objectId,
        identity: item.identity,
        observedVersion: item.observedVersion,
      },
    ]),
  ),
});

export function stableOperationId(...parts: string[]): string {
  const bytes = createHash("sha256").update(parts.join("\0")).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function writeImportedFragment(path: string, content: string) {
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== content)
      throw new CliError(`Import fragment ${path} already exists; refusing to overwrite it`);
  }
}

export const iacInitCommand = define({
  name: "init",
  description: "Create a native Weldall YAML workspace and lockfile",
  args: { issuer: { type: "string", required: true }, name: { type: "string", required: true } },
  run: async (context) => {
    const root = process.cwd();
    for (const path of [MANIFEST_FILE, "weldall.lock.yml"])
      await access(join(root, path))
        .then(() => {
          throw new CliError(`${path} already exists`);
        })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
    const manifest = {
      apiVersion: "weldall.dev/v1alpha1" as const,
      workspace: { name: context.values.name, issuer: new URL(context.values.issuer).origin },
      include: ["weldall/**/*.yml"],
    };
    await mkdir(join(root, "weldall"), { recursive: true });
    await writeFile(join(root, MANIFEST_FILE), stringify(manifest), { flag: "wx" });
    await writeLock(root, newLock(manifest));
    console.log(`Created ${MANIFEST_FILE} and weldall.lock.yml`);
  },
});
export const iacValidateCommand = define({
  name: "validate",
  description: "Validate and canonicalize native Weldall YAML locally",
  args: { json: jsonArgument },
  run: async (context) => {
    const workspace = await loadWorkspace();
    const value = {
      valid: true,
      objectCount: [
        "scopes",
        "resources",
        "machines",
        "emailAssignments",
        "groupAssignments",
      ].reduce(
        (count, section) => count + Object.keys((workspace.manifest as any)[section] ?? {}).length,
        0,
      ),
      workspace: workspace.manifest.workspace,
    };
    if (context.values.json) console.log(JSON.stringify(value));
    else
      console.log(
        `Valid native Weldall YAML for ${value.workspace.name} (${value.objectCount} objects).`,
      );
  },
});
export const iacPlanCommand = define({
  name: "plan",
  description: "Preview deterministic native Weldall YAML changes",
  args: { json: jsonArgument, detailedExitCode: { type: "boolean", toKebab: true } },
  run: async (context) => {
    const workspace = await loadWorkspace();
    if (!workspace.lock)
      throw new CliError("weldall.lock.yml is required; run weldall init or state pull");
    const client = await IacClient.connect(workspace.manifest, workspace.lock);
    const plan = await client.request("/plan", "POST", {
      manifest: serverManifest(workspace.manifest, workspace.lock),
    });
    if (context.values.json) console.log(JSON.stringify(plan));
    else printPlan(plan);
    if (context.values.detailedExitCode && plan.actions.some((item: any) => item.action !== "noop"))
      process.exitCode = 2;
  },
});
export const iacUpCommand = define({
  name: "up",
  description: "Atomically apply one native Weldall YAML snapshot",
  args: { yes: yesArgument },
  run: async (context) => {
    const workspace = await loadWorkspace();
    if (!workspace.lock) throw new CliError("weldall.lock.yml is required");
    const client = await IacClient.connect(workspace.manifest, workspace.lock);
    const manifest = serverManifest(workspace.manifest, workspace.lock);
    const plan = await client.request("/plan", "POST", { manifest });
    printPlan(plan);
    const changes = plan.actions.filter((item: any) => item.action !== "noop");
    if (plan.blockers.length) throw new CliError("Plan is blocked");
    if (!changes.length) return;
    if (!context.values.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new CliError("Non-interactive apply requires --yes");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if ((await prompt.question("Apply this complete snapshot? Type yes: ")).trim() !== "yes")
          throw new CliError("Apply cancelled");
      } finally {
        prompt.close();
      }
    }
    const result = await client.request("/apply", "POST", {
      manifest,
      plannedRevision: plan.revision,
      configDigest: plan.configDigest,
      planDigest: plan.digest,
      operationId: randomUUID(),
    });
    const state = await client.request(`/workspaces/${workspace.lock.workspace.id}/state`, "GET");
    const lock = lockFromState(workspace.lock, client.installationId, state);
    await writeLock(workspace.root, lock);
    console.log(`Applied revision ${result.resultingRevision}.`);
  },
});
const importKinds = ["scope", "resource", "machine", "emailAssignment", "groupAssignment"];
export const iacImportCommand = define({
  name: "import",
  description: "Explicitly claim a manual primitive for this workspace",
  args: {
    kind: { type: "positional", required: true },
    identity: { type: "positional", required: true },
    as: { type: "string", required: true },
  },
  run: async (context) => {
    if (!importKinds.includes(context.values.kind))
      throw new CliError(`Kind must be ${importKinds.join(", ")}`);
    const workspace = await loadWorkspace();
    if (!workspace.lock) throw new CliError("weldall.lock.yml is required");
    const [kind, name] = context.values.as.split(".", 2);
    if (!kind || !name)
      throw new CliError("--as must be a logical address such as scope.expenses_read");
    const sections: Record<string, string> = {
      scope: "scopes",
      resource: "resources",
      machine: "machines",
      emailAssignment: "emailAssignments",
      groupAssignment: "groupAssignments",
    };
    const section = sections[kind];
    if (!section || kind !== context.values.kind)
      throw new CliError("--as kind must match the imported primitive kind");
    const path = join(workspace.root, "weldall", `${kind}-${name}.imported.yml`);
    await access(path)
      .then(() => {
        throw new CliError(`Import fragment ${path} already exists; refusing to overwrite it`);
      })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    const client = await IacClient.connect(workspace.manifest, workspace.lock);
    const result = await client.request("/import", "POST", {
      workspace: { ...workspace.manifest.workspace, id: workspace.lock.workspace.id },
      kind: context.values.kind,
      identity: context.values.identity,
      address: context.values.as,
      operationId: stableOperationId(
        workspace.lock.workspace.id,
        String(workspace.lock.workspace.observedRevision),
        "import",
        context.values.kind,
        context.values.identity,
        context.values.as,
      ),
    });
    await writeImportedFragment(path, stringify({ [section]: { [name]: result.state } }));
    workspace.lock.workspace.observedRevision = result.revision;
    workspace.lock.objects[context.values.as] = {
      kind: context.values.kind,
      objectId: result.objectId,
      identity: context.values.identity,
    };
    await writeLock(workspace.root, lockWithDiscovery(workspace.lock, client.installationId));
    console.log(`Imported ${context.values.identity} as ${context.values.as}.`);
  },
});
export const iacUnmanageCommand = define({
  name: "unmanage",
  description: "Preserve a primitive while releasing workspace ownership",
  args: { address: { type: "positional", required: true }, yes: yesArgument },
  run: async (context) => {
    if (!context.values.yes) throw new CliError("unmanage requires --yes");
    const workspace = await loadWorkspace();
    if (!workspace.lock) throw new CliError("weldall.lock.yml is required");
    const sections: any = {
      scope: "scopes",
      resource: "resources",
      machine: "machines",
      emailAssignment: "emailAssignments",
      groupAssignment: "groupAssignments",
    };
    const [kind, name] = context.values.address.split(".", 2);
    if (kind && name && (workspace.manifest as any)[sections[kind]]?.[name])
      throw new CliError("Remove the declaration before unmanaging it");
    const client = await IacClient.connect(workspace.manifest, workspace.lock);
    const result = await client.request("/unmanage", "POST", {
      workspaceId: workspace.lock.workspace.id,
      address: context.values.address,
      operationId: stableOperationId(
        workspace.lock.workspace.id,
        String(workspace.lock.workspace.observedRevision),
        "unmanage",
        context.values.address,
      ),
    });
    workspace.lock.workspace.observedRevision = result.revision;
    delete workspace.lock.objects[context.values.address];
    await writeLock(workspace.root, lockWithDiscovery(workspace.lock, client.installationId));
    console.log(`Unmanaged ${context.values.address}.`);
  },
});
const statePull = define({
  name: "pull",
  description: "Reconstruct lockfile mappings from authoritative server ownership",
  args: { workspaceId: { type: "string", toKebab: true } },
  run: async (context) => {
    const workspace = await loadWorkspace();
    if (!workspace.lock && !context.values.workspaceId)
      throw new CliError("state pull without a lock requires --workspace-id <uuid>");
    const generated = newLock(workspace.manifest);
    const lock = workspace.lock ?? {
      ...generated,
      workspace: { ...generated.workspace, id: context.values.workspaceId! },
    };
    if (
      context.values.workspaceId &&
      workspace.lock &&
      workspace.lock.workspace.id !== context.values.workspaceId
    )
      throw new CliError("--workspace-id does not match the existing lockfile");
    const client = await IacClient.connect(workspace.manifest, lock);
    const state = await client.request(`/workspaces/${lock.workspace.id}/state`, "GET");
    const recovered = lockFromState(lock, client.installationId, state);
    await writeLock(workspace.root, recovered);
    console.log(`Pulled revision ${state.workspace.revision}.`);
  },
});
const stateMove = define({
  name: "mv",
  description: "Move a logical address without replacing its remote primitive",
  args: {
    from: { type: "positional", required: true },
    to: { type: "positional", required: true },
  },
  run: async (context) => {
    const workspace = await loadWorkspace();
    if (!workspace.lock) throw new CliError("weldall.lock.yml is required");
    const fromKind = context.values.from.split(".", 1)[0];
    const toKind = context.values.to.split(".", 1)[0];
    if (fromKind !== toKind) throw new CliError("State moves must keep the same primitive kind");
    const client = await IacClient.connect(workspace.manifest, workspace.lock);
    const result = await client.request("/state/move", "POST", {
      workspaceId: workspace.lock.workspace.id,
      from: context.values.from,
      to: context.values.to,
      operationId: stableOperationId(
        workspace.lock.workspace.id,
        String(workspace.lock.workspace.observedRevision),
        "state-move",
        context.values.from,
        context.values.to,
      ),
    });
    workspace.lock.workspace.observedRevision = result.revision;
    const entry = workspace.lock.objects[context.values.from];
    if (entry) {
      workspace.lock.objects[context.values.to] = entry;
      delete workspace.lock.objects[context.values.from];
    }
    await writeLock(workspace.root, lockWithDiscovery(workspace.lock, client.installationId));
    console.log(`Moved ${context.values.from} to ${context.values.to}.`);
  },
});
export const iacStateCommand = define({
  name: "state",
  description: "Recover or move native Weldall workspace state",
  subCommands: { pull: statePull, mv: stateMove },
  run: () => console.log("Run `weldall state --help`."),
});
