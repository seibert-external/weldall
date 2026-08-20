import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  iacUnmanageCommand,
  lockFromState,
  printPlan,
  stableOperationId,
  writeImportedFragment,
} from "../src/iac/commands.js";
import { IacClient } from "../src/iac/client.js";

async function workspace(root: string, extra = "") {
  await writeFile(
    join(root, "weldall.yml"),
    `apiVersion: weldall.dev/v1\nworkspace:\n  name: platform\n  issuer: https://weldall.example.com\n${extra}`,
  );
}

const importContext = {
  values: { kind: "scope", identity: "expenses:read", as: "scope.read" },
};

describe("native YAML workspaces", () => {
  it("serializes a CLI logo declaration without defaulting empty values", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(root, 'cli:\n  logoUrl: ""\n');
    const loaded = await loadWorkspace(root);
    const manifest = serverManifest(loaded.manifest, newLock(loaded.manifest));
    expect(manifest.cli).toEqual({ logoUrl: "" });
    expect(canonicalManifestDigest(manifest)).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      (async () => {
        await workspace(root, "cli:\n  logoUrl: http://example.com/logo.svg\n");
        return loadWorkspace(root);
      })(),
    ).rejects.toThrow(/HTTPS/);
  });

  it("rejects a noncanonical HTTPS init issuer without creating workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect(
        (iacInitCommand as any).run({
          values: { issuer: "http://weldall.example.com", name: "platform" },
        }),
      ).rejects.toThrow(/HTTPS/);
      await expect(access(join(root, "weldall.yml"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, "weldall.lock.yml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
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
      await expect((iacImportCommand as any).run(importContext)).rejects.toThrow("unreachable");
      expect(await readFile(join(root, "weldall.yml"), "utf8")).toBe(originalManifest);
      await expect(access(join(root, "weldall", "imports"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.chdir(previous);
      connect.mockRestore();
    }
  });

  it("imports a skill with the command payload and writes a skills fragment", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(root);
    const loaded = await loadWorkspace(root);
    const lock = newLock(loaded.manifest);
    await writeLock(root, lock);
    const skill = {
      slug: "expenses.review",
      title: "Review expenses",
      content: "# Review expenses\n\nUse approved steps.",
      requiredScopes: ["expenses:read"],
      visibility: "HIDDEN_IF_UNALLOWED",
      meta: { tags: ["finance", "review"], owner: "user-123" },
      lastUpdatedAt: "unrestricted update value",
    };
    const client = {
      installationId: "00000000-0000-4000-8000-000000000001",
      request: vi.fn(async (path: string, _method: string, _body?: any) =>
        path === "/import"
          ? { state: skill }
          : {
              workspace: { id: lock.workspace.id, name: "platform", revision: 1 },
              objects: [
                {
                  address: "skill.review",
                  kind: "skill",
                  objectId: "skill-id",
                  identity: skill.slug,
                  observedVersion: 1,
                },
              ],
            },
      ),
    };
    const connect = vi.spyOn(IacClient, "connect").mockResolvedValue(client as any);
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect(
        (iacImportCommand as any).run({
          values: { kind: "skill", identity: skill.slug, as: "skill.review" },
        }),
      ).resolves.toBeUndefined();
      const importCall = client.request.mock.calls.find(([path]) => path === "/import");
      expect(importCall).toEqual([
        "/import",
        "POST",
        {
          workspace: { ...loaded.manifest.workspace, id: lock.workspace.id },
          kind: "skill",
          identity: skill.slug,
          address: "skill.review",
          operationId: stableOperationId(
            lock.workspace.id,
            "0",
            "import",
            "skill",
            skill.slug,
            "skill.review",
          ),
        },
      ]);
      const generated = (await import("yaml")).parse(
        await readFile(join(root, "weldall", "imports", "skill-review.yml"), "utf8"),
      );
      expect(generated).toEqual({ skills: { review: skill } });
      expect(await readFile(join(root, "weldall.yml"), "utf8")).toContain(
        "- weldall/imports/skill-review.yml",
      );
    } finally {
      process.chdir(previous);
      connect.mockRestore();
    }
  });

  it("maps skill declarations when preflighting unmanage", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(
      root,
      "skills:\n  review:\n    slug: expenses.review\n    title: Review expenses\n    content: '# Review'\n    requiredScopes: []\n    visibility: DEFAULT\n",
    );
    const loaded = await loadWorkspace(root);
    await writeLock(root, newLock(loaded.manifest));
    const connect = vi.spyOn(IacClient, "connect");
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect(
        (iacUnmanageCommand as any).run({ values: { address: "skill.review", yes: true } }),
      ).rejects.toThrow("Remove the declaration before unmanaging it");
      expect(connect).not.toHaveBeenCalled();
    } finally {
      process.chdir(previous);
      connect.mockRestore();
    }
  });

  it("replays a committed import after a local state failure with a glob-covered fragment", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(root, "include:\n  - weldall/**/*.yml\n");
    const loaded = await loadWorkspace(root);
    const originalLock = newLock(loaded.manifest);
    await writeLock(root, originalLock);
    const originalLockSource = await readFile(join(root, "weldall.lock.yml"), "utf8");
    const state = { key: "expenses:read", description: "Read expenses" };
    const operationIds: string[] = [];
    let importRequests = 0;
    const client = {
      installationId: "00000000-0000-4000-8000-000000000001",
      request: vi.fn(async (path: string, _method: string, body?: any) => {
        if (path === "/import") {
          operationIds.push(body.operationId);
          importRequests++;
          if (importRequests === 1) {
            await rm(join(root, "weldall.lock.yml"));
            await mkdir(join(root, "weldall.lock.yml"));
          }
          return { state };
        }
        return {
          workspace: { id: originalLock.workspace.id, name: "platform", revision: 1 },
          objects: [],
        };
      }),
    };
    const connect = vi.spyOn(IacClient, "connect").mockResolvedValue(client as any);
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect((iacImportCommand as any).run(importContext)).rejects.toThrow();
      await rm(join(root, "weldall.lock.yml"), { recursive: true });
      await writeFile(join(root, "weldall.lock.yml"), originalLockSource);
      await expect((iacImportCommand as any).run(importContext)).resolves.toBeUndefined();
      expect(operationIds).toHaveLength(2);
      expect(operationIds[1]).toBe(operationIds[0]);
      expect(await readFile(join(root, "weldall", "imports", "scope-read.yml"), "utf8")).toBe(
        "scopes:\n  read:\n    key: expenses:read\n    description: Read expenses\n",
      );
      expect(await readFile(join(root, "weldall.yml"), "utf8")).toContain("- weldall/**/*.yml");
    } finally {
      process.chdir(previous);
      connect.mockRestore();
    }
  });

  it("rejects import fragment mismatches and unrelated declaration collisions", async () => {
    const mismatchRoot = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(mismatchRoot, "include:\n  - weldall/**/*.yml\n");
    await writeImportedFragment(
      join(mismatchRoot, "weldall", "imports", "scope-read.yml"),
      "scopes:\n  read:\n    key: expenses:read\n    description: Stale\n",
    );
    const mismatchWorkspace = await loadWorkspace(mismatchRoot);
    await writeLock(mismatchRoot, newLock(mismatchWorkspace.manifest));
    const client = {
      installationId: "00000000-0000-4000-8000-000000000001",
      request: vi.fn().mockResolvedValue({
        state: { key: "expenses:read", description: "Current" },
      }),
    };
    const connect = vi.spyOn(IacClient, "connect").mockResolvedValue(client as any);
    const previous = process.cwd();
    try {
      process.chdir(mismatchRoot);
      await expect((iacImportCommand as any).run(importContext)).rejects.toThrow(
        /does not match the committed import result/,
      );

      const collisionRoot = await mkdtemp(join(tmpdir(), "weldall-iac-"));
      await workspace(
        collisionRoot,
        "scopes:\n  read:\n    key: expenses:read\n    description: Manual declaration\n",
      );
      const collisionWorkspace = await loadWorkspace(collisionRoot);
      await writeLock(collisionRoot, newLock(collisionWorkspace.manifest));
      process.chdir(collisionRoot);
      await expect((iacImportCommand as any).run(importContext)).rejects.toThrow(
        /already declared/,
      );
      expect(client.request).toHaveBeenCalledTimes(1);
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
      apiVersion: "weldall.dev/v1",
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
      skills: {},
      emailAssignments: {},
      groupAssignments: {},
    };
    expect(canonicalManifestDigest(omittedAndUnsorted)).toBe(canonicalManifestDigest(canonical));
    expect(canonicalManifestDigest(omittedAndUnsorted)).toBe(
      "c2e1311af97134bca5534c104566d7efa1d873bc61d3ff8f71f2ddf3caa6a054",
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
      apiVersion: "weldall.dev/v1" as const,
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

  it("validates and canonicalizes inline administrator skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    await workspace(
      root,
      "skills:\n  review:\n    slug: expenses.review\n    title: Review expenses\n    content: '# Review expenses'\n    requiredScopes: [expenses:write, expenses:read]\n    visibility: HIDDEN_IF_UNALLOWED\n    meta:\n      tags: [finance, review, finance]\n      owner: user-123\n    lastUpdatedAt: not-a-timestamp\n",
    );
    const loaded = await loadWorkspace(root);
    const lock = newLock(loaded.manifest);
    expect(serverManifest(loaded.manifest, lock).skills.review).toEqual({
      slug: "expenses.review",
      title: "Review expenses",
      content: "# Review expenses",
      requiredScopes: ["expenses:read", "expenses:write"],
      visibility: "HIDDEN_IF_UNALLOWED",
      meta: { tags: ["finance", "review", "finance"], owner: "user-123" },
      lastUpdatedAt: "not-a-timestamp",
    });
    expect(
      declaredImportValue({ skills: { review: { slug: "expenses.review" } } }, "skill.review"),
    ).toEqual({ slug: "expenses.review" });
    expect(
      canonicalManifestDigest({
        apiVersion: "weldall.dev/v1",
        workspace: {
          id: "67ade6dc-0000-4000-8000-000000000000",
          name: "platform",
          issuer: "https://weldall.example.com",
        },
        skills: {
          review: {
            slug: "expenses.review",
            title: "Review",
            content: "# Review",
            requiredScopes: ["expenses:write", "expenses:read"],
            visibility: "DEFAULT",
          },
        },
      }),
    ).toBe("990a499264dbf19bde564967075d9abaa74fbcdffec75d1141fdecf723607ff3");

    await workspace(
      root,
      "skills:\n  review:\n    slug: Expenses Review\n    title: Review\n    content: '  markdown  '\n    requiredScopes: []\n    visibility: PUBLIC\n",
    );
    await expect(loadWorkspace(root)).rejects.toThrow(/skills/);
  });

  it("accepts provider group IDs up to the persistence limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-iac-"));
    const groupId = "g".repeat(191);
    await workspace(
      root,
      `groupAssignments:\n  staged:\n    provider: directory\n    groupId: ${groupId}\n    scopes: [expenses:read]\n`,
    );
    expect((await loadWorkspace(root)).manifest.groupAssignments?.staged).toMatchObject({
      groupId,
    });
    await workspace(
      root,
      `groupAssignments:\n  staged:\n    provider: directory\n    groupId: ${"g".repeat(192)}\n    scopes: [expenses:read]\n`,
    );
    await expect(loadWorkspace(root)).rejects.toThrow(/groupId/);
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
