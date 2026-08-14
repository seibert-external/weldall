import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalManifestDigest,
  loadWorkspace,
  newLock,
  serverManifest,
  writeLock,
} from "../src/iac/manifest.js";
import {
  declaredImportValue,
  ensureImportedFragmentIncluded,
  iacImportCommand,
  iacInitCommand,
  lockFromState,
  printPlan,
  stableOperationId,
  writeImportedFragment,
} from "../src/iac/commands.js";
import { IacClient } from "../src/iac/client.js";

async function workspace(root: string, extra = "") {
  await writeFile(
    join(root, "weldall.yml"),
    `apiVersion: weldall.dev/v1alpha1\nworkspace:\n  name: platform\n  issuer: https://weldall.example.com\n${extra}`,
  );
}

describe("native YAML workspaces", () => {
  it("rejects a noncanonical HTTPS init issuer without creating workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect(
        (iacInitCommand as any).run({ values: { issuer: "http://weldall.example.com", name: "platform" } }),
      ).rejects.toThrow(/HTTPS/);
      await expect(access(join(root, "weldall.yml"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, "weldall.lock.yml"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, "weldall"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(previous);
    }
  });

  it("does not mutate local import files before the remote import succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(root);
    const loaded = await loadWorkspace(root);
    await writeLock(root, newLock(loaded.manifest));
    const originalManifest = await readFile(join(root, "weldall.yml"), "utf8");
    const connect = vi.spyOn(IacClient, "connect").mockRejectedValue(new Error("unreachable"));
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect(
        (iacImportCommand as any).run({
          values: { kind: "scope", identity: "expenses:read", as: "scope.read" },
        }),
      ).rejects.toThrow("unreachable");
      expect(await readFile(join(root, "weldall.yml"), "utf8")).toBe(originalManifest);
      await expect(access(join(root, "weldall", "imports"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(previous);
      connect.mockRestore();
    }
  });

  it("loads sorted fragments, creates an opaque UUID lock, and injects it only for the API", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await mkdir(join(root, "weldall"));
    await workspace(root, "include:\n  - weldall/*.yml\n");
    await writeFile(
      join(root, "weldall", "b.yml"),
      "scopes:\n  write:\n    key: expenses:write\n    description: Write\n",
    );
    await writeFile(
      join(root, "weldall", "a.yml"),
      "scopes:\n  read:\n    key: expenses:read\n    description: Read\n",
    );
    const loaded = await loadWorkspace(root);
    const lock = newLock(loaded.manifest);
    await writeLock(root, lock);
    expect(Object.keys(loaded.manifest.scopes!)).toEqual(["read", "write"]);
    expect(lock.workspace.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(serverManifest(loaded.manifest, lock).workspace.id).toBe(lock.workspace.id);
    expect(JSON.stringify(lock)).not.toContain("private");
  });

  it("preflights loaded declarations and permits only exact generated import recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    const path = join(root, "weldall", "imports", "scope-read.yml");
    const exact = "scopes:\n  read:\n    key: expenses:read\n    description: Read\n";
    await writeImportedFragment(path, exact);
    await expect(writeImportedFragment(path, exact)).resolves.toBeUndefined();
    await expect(writeImportedFragment(path, `${exact}# different\n`)).rejects.toThrow(
      /refusing to overwrite/,
    );
    await expect(readFile(path, "utf8")).resolves.toBe(exact);
    expect(
      declaredImportValue(
        { scopes: { read: { key: "expenses:read", description: "Read" } } },
        "scope.read",
      ),
    ).toEqual({ key: "expenses:read", description: "Read" });
  });

  it("adds an exact generated fragment to the root include list atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(root);
    const path = join(root, "weldall", "imports", "scope-read.yml");
    await mkdir(join(root, "weldall", "imports"), { recursive: true });
    await ensureImportedFragmentIncluded(root, path);
    await ensureImportedFragmentIncluded(root, path);
    expect(await readFile(join(root, "weldall.yml"), "utf8")).toContain(
      "- weldall/imports/scope-read.yml",
    );
  });

  it("derives retry-stable but revision-distinct import operation IDs", () => {
    const first = stableOperationId("workspace", "7", "import", "scope", "expenses:read");
    expect(first).toBe(stableOperationId("workspace", "7", "import", "scope", "expenses:read"));
    expect(first).toBe(stableOperationId("workspace", "7", "import", "scope", "expenses:read"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toContain("expenses");
    expect(first).not.toBe(
      stableOperationId("workspace", "7", "import", "scope", "expenses:write"),
    );
    expect(first).not.toBe(stableOperationId("workspace", "9", "import", "scope", "expenses:read"));
  });

  it("digests the same canonical parsed manifest despite ordering and omitted defaults", () => {
    const workspace = {
      id: "67ade6dc-0000-4000-8000-000000000000",
      name: "platform",
      issuer: "https://weldall.example.com",
    };
    const omittedAndUnsorted = {
      apiVersion: "weldall.dev/v1alpha1",
      workspace,
      resources: {
        api: {
          key: "api",
          name: "API",
          resourceIdentifier: "https://api.example.com/v1",
          authorizationServer: "https://auth.example.com",
          downstreamClientId: "api",
          enabled: true,
          requestPrefixes: ["https://api.example.com/v2", "https://api.example.com/v1"],
          scopes: ["expenses:write", "expenses:read"],
        },
      },
    };
    const canonical = {
      ...omittedAndUnsorted,
      scopes: {},
      resources: {
        api: {
          ...omittedAndUnsorted.resources.api,
          skillDiscoveryEnabled: false,
          requestPrefixes: ["https://api.example.com/v1", "https://api.example.com/v2"],
          scopes: ["expenses:read", "expenses:write"],
        },
      },
      machines: {},
      emailAssignments: {},
      groupAssignments: {},
    };
    expect(canonicalManifestDigest(omittedAndUnsorted)).toBe(canonicalManifestDigest(canonical));
    expect(canonicalManifestDigest(omittedAndUnsorted)).toBe(
      "26620cbee81118a71e72ad6d1905771cb01b1c5967c9673f064557ed3f3d152f",
    );
    const lock = {
      version: 1 as const,
      server: { issuer: workspace.issuer, installationId: null },
      workspace: { id: workspace.id, name: workspace.name, observedRevision: 0 },
      objects: {},
    };
    expect(serverManifest(omittedAndUnsorted as any, lock)).toEqual(canonical);
  });

  it("reconstructs the complete lock from authoritative state, including no-op objects", () => {
    const manifest = {
      apiVersion: "weldall.dev/v1alpha1" as const,
      workspace: { name: "platform", issuer: "https://weldall.example.com" },
    };
    const lock = newLock(manifest);
    const rebuilt = lockFromState(lock, "installation", {
      workspace: { id: lock.workspace.id, name: "platform", revision: 7 },
      objects: [
        {
          address: "scope.unchanged",
          kind: "scope",
          objectId: "scope-id",
          identity: "expenses:read",
          observedVersion: 4,
        },
      ],
    });
    expect(rebuilt.workspace.observedRevision).toBe(7);
    expect(rebuilt.objects["scope.unchanged"]).toEqual({
      kind: "scope",
      objectId: "scope-id",
      identity: "expenses:read",
      observedVersion: 4,
    });
  });

  it("prints deterministic human plans without key coordinates", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const plan = {
      actions: [
        { action: "update", address: "scope.z", identity: "z:read" },
        {
          action: "register_key",
          address: "machine.a",
          identity: "runner",
          keyId: "next",
          keyThumbprint: "public-thumbprint",
        },
      ],
      blockers: [
        { code: "Z", address: "scope.z", message: "later" },
        { code: "A", address: "scope.a", message: "first" },
      ],
    };
    printPlan(plan);
    const first = output.mock.calls.map(([line]) => line);
    output.mockClear();
    printPlan({
      ...plan,
      actions: [...plan.actions].reverse(),
      blockers: [...plan.blockers].reverse(),
    });
    expect(output.mock.calls.map(([line]) => line)).toEqual(first);
    expect(first).toEqual([
      "register_key machine.a (runner)",
      "update       scope.z (z:read)",
      "blocked      scope.a: first",
      "blocked      scope.z: later",
    ]);
    expect(JSON.stringify(first)).not.toMatch(/public-thumbprint|\"x\"|\"y\"|\"d\"/);
    output.mockRestore();
  });

  it("rejects unknown fields, missing required values, empty relations, and noncanonical URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(
      root,
      "resources:\n  api:\n    key: api\n    name: API\n    resourceIdentifier: http://api.example.com\n    authorizationServer: https://auth.example.com/path\n    downstreamClientId: api\n    enabled: yes\n    requestPrefixes: []\n    scopes: []\n    extra: no\n",
    );
    await expect(loadWorkspace(root)).rejects.toThrow();
    await workspace(
      root,
      "emailAssignments:\n  alice:\n    email: alice@example.com\n    scopes: []\n",
    );
    await expect(loadWorkspace(root)).rejects.toThrow(/scopes/);
  });

  it("rejects aliases, private keys, duplicate addresses, and escaping includes", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await mkdir(join(root, "weldall"));
    await workspace(
      root,
      "machines:\n  runner:\n    clientId: runner\n    name: Runner\n    enabled: true\n    publicKeys:\n      bad:\n        kty: EC\n        crv: P-256\n        x: x\n        y: y\n        d: secret\n    resources: []\n    scopes: [weldall:iac]\n",
    );
    await expect(loadWorkspace(root)).rejects.toThrow(/Private JWK/);
    await workspace(root, "include:\n  - ../outside.yml\n");
    await expect(loadWorkspace(root)).rejects.toThrow(/cannot contain/);
  });
});
