import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { resolveNpmInvocation } from "./npm-invocation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const bundle = await readFile(join(root, "dist", "index.js"), "utf8");
const npm = resolveNpmInvocation();
const packed = JSON.parse(
  execFileSync(npm.command, [...npm.prefix, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }),
)[0];
const files = packed.files.map(({ path }) => path).sort();

assert.equal(packageJson.name, "@weldall/cli");
assert.equal(packageJson.private, undefined);
assert.equal(packageJson.os, undefined);
assert.equal(packageJson.engines?.node, ">=22.15.0");
assert.equal(packageJson.bin?.weldall, "dist/index.js");
assert.equal(packageJson.publishConfig?.access, "public");
assert.deepEqual(files, ["LICENSE", "README.md", "dist/index.js", "package.json"]);
assert.equal(packageJson.dependencies?.["@weldall/sdk"], undefined);
for (const specifier of Object.values(packageJson.dependencies ?? {}))
  assert.doesNotMatch(specifier, /^(?:workspace:|link:|file:)/);
assert.match(bundle, /^#!\/usr\/bin\/env -S node --use-system-ca\n/);
assert.match(bundle, /import\("@napi-rs\/keyring"\)/);
assert.equal(packageJson.optionalDependencies?.["@napi-rs/keyring"], "1.3.0");
assert.doesNotMatch(bundle, /@weldall\/oauth/);
assert.doesNotMatch(bundle, /(?:from|import\()\s*["']@weldall\/sdk/);
assert.doesNotMatch(bundle, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
if (process.platform !== "win32") await access(join(root, "dist", "index.js"), constants.X_OK);

console.log(`Verified ${packed.name}: ${files.join(", ")}`);
