import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspace, newLock, serverManifest, writeLock } from "../src/iac/manifest.js";

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
