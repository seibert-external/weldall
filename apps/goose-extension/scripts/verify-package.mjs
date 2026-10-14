import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(fileURLToPath(new URL("../../../.goose-test-pack-", import.meta.url)));
try {
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
    }),
  );
  assert.deepEqual(pack.files.map((file) => file.path).sort(), [
    "LICENSE",
    "README.md",
    "dist/index.js",
    "dist/server.json",
    "package.json",
  ]);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const value of Object.values(pkg.dependencies)) assert.match(value, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.equal(pkg.scripts.install, undefined);
  assert.deepEqual(Object.keys(pkg.bin), ["weldall-goose"]);
  const code = await readFile(path.join(root, "dist/index.js"), "utf8");
  for (const forbidden of [
    "@napi-rs/keyring",
    "createDpopProof",
    "privateJwk",
    "FAKE_WAIT",
    "goose-white-label",
  ])
    assert.ok(!code.includes(forbidden), forbidden);
  const metadata = JSON.parse(await readFile(path.join(root, "dist/server.json"), "utf8"));
  assert.equal(metadata.version, pkg.version);
  assert.equal(metadata.name, pkg.mcpName);
  assert.equal(metadata.packages[0].version, pkg.version);
  console.log("Packed files, dependency boundary and versioned Registry metadata verified.");
} finally {
  await rm(temp, { recursive: true, force: true });
}
