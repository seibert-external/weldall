import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
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
const printPlan = (plan: any) => {
  for (const action of plan.actions.filter((item: any) => item.action !== "noop"))
    console.log(`${action.action.padEnd(12)} ${action.address} (${action.identity})`);
  for (const blocker of plan.blockers)
    console.log(`blocked      ${blocker.address ?? "workspace"}: ${blocker.message}`);
  if (!plan.actions.some((item: any) => item.action !== "noop")) console.log("No changes.");
};
const lockWithDiscovery = (lock: Lockfile, installationId: string) => ({
  ...lock,
  server: { ...lock.server, installationId },
});

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
    if (!changes.length) return;
    if (plan.blockers.length) throw new CliError("Plan is blocked");
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
    const lock = lockWithDiscovery(workspace.lock, client.installationId);
    lock.workspace.observedRevision = result.resultingRevision;
    lock.objects = Object.fromEntries(
      result.actions.map((item: any) => [
        item.address,
        { kind: item.kind, objectId: null, identity: item.identity },
      ]),
    );
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
    const client = await IacClient.connect(workspace.manifest, workspace.lock);
    const result = await client.request("/import", "POST", {
      workspace: { ...workspace.manifest.workspace, id: workspace.lock.workspace.id },
      kind: context.values.kind,
      identity: context.values.identity,
      address: context.values.as,
      operationId: randomUUID(),
    });
    const [section, name] = context.values.as.split(".", 2);
    if (!section || !name)
      throw new CliError("--as must be a logical address such as scope.expenses_read");
    const path = join(workspace.root, "weldall", `${name}.imported.yml`);
    await writeFile(path, stringify({ [`${section}s`]: { [name]: result.state } }), { flag: "wx" });
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
    await client.request("/unmanage", "POST", {
      workspaceId: workspace.lock.workspace.id,
      address: context.values.address,
      operationId: randomUUID(),
    });
    delete workspace.lock.objects[context.values.address];
    await writeLock(workspace.root, lockWithDiscovery(workspace.lock, client.installationId));
    console.log(`Unmanaged ${context.values.address}.`);
  },
});
const statePull = define({
  name: "pull",
  description: "Reconstruct lockfile mappings from authoritative server ownership",
  run: async () => {
    const workspace = await loadWorkspace();
    const lock = workspace.lock ?? newLock(workspace.manifest);
    const client = await IacClient.connect(workspace.manifest, lock);
    const state = await client.request(`/workspaces/${lock.workspace.id}/state`, "GET");
    lock.server.installationId = client.installationId;
    lock.workspace.observedRevision = state.workspace.revision;
    lock.objects = Object.fromEntries(
      state.objects.map((item: any) => [
        item.address,
        { kind: item.kind, objectId: item.objectId, identity: item.identity },
      ]),
    );
    await writeLock(workspace.root, lock);
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
    const client = await IacClient.connect(workspace.manifest, workspace.lock);
    await client.request("/state/move", "POST", {
      workspaceId: workspace.lock.workspace.id,
      from: context.values.from,
      to: context.values.to,
      operationId: randomUUID(),
    });
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
