import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadWorkspace, newLock, serverManifest, writeLock } from "../src/iac/manifest.js";
import { printPlan, stableOperationId } from "../src/iac/commands.js";

async function workspace(root: string, extra = "") {
  await writeFile(
    join(root, "weldall.yml"),
    `apiVersion: weldall.dev/v1alpha1\nworkspace:\n  name: platform\n  issuer: https://weldall.example.com\n${extra}`,
  );
}

describe("native YAML workspaces", () => {
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

  it("derives retry-stable UUID operation IDs without exposing request content", () => {
    const first = stableOperationId("workspace", "import", "scope", "expenses:read");
    expect(first).toBe(stableOperationId("workspace", "import", "scope", "expenses:read"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toContain("expenses");
    expect(first).not.toBe(stableOperationId("workspace", "import", "scope", "expenses:write"));
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
