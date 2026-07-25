import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const bundle = await readFile(join(root, "dist", "index.js"), "utf8");
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  }),
)[0];
const files = packed.files.map(({ path }) => path).sort();

assert.equal(packageJson.name, "@weldall/ci");
assert.equal(packageJson.private, undefined);
assert.deepEqual(packageJson.os, ["darwin"]);
assert.equal(packageJson.engines?.node, ">=22.15.0");
assert.equal(packageJson.bin?.weldall, "dist/index.js");
assert.equal(packageJson.publishConfig?.access, "public");
assert.deepEqual(files, ["README.md", "dist/index.js", "package.json"]);
assert.equal(packageJson.dependencies?.["@weldall/oauth"], undefined);
for (const specifier of Object.values(packageJson.dependencies ?? {}))
  assert.doesNotMatch(specifier, /^(?:workspace:|link:|file:)/);
assert.match(bundle, /^#!\/usr\/bin\/env -S node --use-system-ca\n/);
assert.match(bundle, /import\("@napi-rs\/keyring"\)/);
assert.doesNotMatch(bundle, /@weldall\/oauth/);
assert.doesNotMatch(bundle, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
await access(join(root, "dist", "index.js"), constants.X_OK);

console.log(`Verified ${packed.name}: ${files.join(", ")}`);
