import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, define } from "gunshi";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IacClient } from "../src/iac/client.js";
import { iacPlanCommand, iacUnmanageCommand, iacUpCommand } from "../src/iac/commands.js";
import { loadWorkspace, newLock, writeLock } from "../src/iac/manifest.js";

const workspaceId = "67ade6dc-0000-4000-8000-000000000000";
const installationId = "00000000-0000-4000-8000-000000000001";
// Frozen pre-connector wire fields: older IaC v1 servers reject unknown top-level keys.
const legacyFields = [
  "apiVersion",
  "workspace",
  "scopes",
  "resources",
  "skills",
  "machines",
  "emailAssignments",
  "groupAssignments",
].sort();
const canonicalJson = (value: any): string =>
  value && typeof value === "object" && !Array.isArray(value)
    ? `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(",")}}`
    : JSON.stringify(value);
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

const run = (argv: string[]) =>
  cli(argv, define({ name: "weldall", run: () => undefined }), {
    name: "weldall",
    version: "0.0.0",
    subCommands: { plan: iacPlanCommand, up: iacUpCommand, unmanage: iacUnmanageCommand },
    renderValidationErrors: null,
  });

let root: string;
let previous: string;
beforeEach(async () => {
  previous = process.cwd();
  root = await mkdtemp(join(tmpdir(), "weldall-iac-compatibility-"));
  await writeFile(
    join(root, "weldall.yml"),
    stringify({
      apiVersion: "weldall.dev/v1",
      workspace: { name: "platform", issuer: "https://weldall.example.com" },
    }),
  );
  const { manifest } = await loadWorkspace(root);
  const lock = newLock(manifest);
  lock.workspace.id = workspaceId;
  lock.objects["scope.read"] = { kind: "scope", objectId: "scope-id", identity: "expenses:read" };
  await writeLock(root, lock);
  process.chdir(root);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  process.chdir(previous);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe.each(["legacy", "connectors"] as const)("IaC against a %s server", (server) => {
  it.each(["plan", "up", "unmanage"] as const)(
    "keeps connector-free %s requests compatible with that server's schema and digest",
    async (command) => {
      let plannedManifest: unknown;
      let configDigest: string;
      const request = vi.fn(async (path: string, _method: string, body?: any) => {
        if (body?.manifest) expect(Object.keys(body.manifest).sort()).toEqual(legacyFields);
        if (path === "/plan") {
          plannedManifest = structuredClone(body.manifest);
          // The new server defaults connectors to {}, while the old server has no such field.
          configDigest = digest(
            server === "connectors" ? { ...body.manifest, connectors: {} } : body.manifest,
          );
          if (server === "connectors") expect(configDigest).not.toBe(digest(body.manifest));
          return {
            configDigest,
            digest: "a".repeat(64),
            revision: 0,
            actions: [{ action: "delete", address: "scope.read", identity: "expenses:read" }],
            blockers: [],
          };
        }
        if (path === "/apply" || path === "/unmanage") {
          expect(plannedManifest).toBeDefined();
          expect(body.manifest).toEqual(plannedManifest);
          expect(body.configDigest).toBe(configDigest!);
          return { revision: 1, resultingRevision: 1 };
        }
        expect(path).toBe(`/workspaces/${workspaceId}/state`);
        return { workspace: { id: workspaceId, name: "platform", revision: 1 }, objects: [] };
      });
      vi.spyOn(IacClient, "connect").mockResolvedValue({
        installationId,
        request,
      } as unknown as IacClient);

      await run(
        command === "unmanage"
          ? [command, "scope.read", "--yes"]
          : command === "up"
            ? [command, "--yes"]
            : [command, "--json"],
      );
      expect(request.mock.calls.map(([path]) => path)).toEqual(
        command === "plan"
          ? ["/plan"]
          : command === "up"
            ? ["/plan", "/apply", `/workspaces/${workspaceId}/state`]
            : ["/plan", "/unmanage"],
      );
      const { lock } = await loadWorkspace(root);
      expect(lock?.workspace.observedRevision).toBe(command === "plan" ? 0 : 1);
      if (command !== "plan") expect(lock?.objects).toEqual({});
    },
  );
});

it("does not unmanage or update the lockfile if obtaining the server digest fails", async () => {
  const originalLock = await readFile(join(root, "weldall.lock.yml"), "utf8");
  const request = vi.fn(async (path: string) => {
    if (path === "/plan") throw new Error("plan unavailable");
    return { revision: 1 };
  });
  vi.spyOn(IacClient, "connect").mockResolvedValue({
    installationId,
    request,
  } as unknown as IacClient);
  await expect(run(["unmanage", "scope.read", "--yes"])).rejects.toThrow("plan unavailable");
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/plan"]);
  expect(await readFile(join(root, "weldall.lock.yml"), "utf8")).toBe(originalLock);
});
