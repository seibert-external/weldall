import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackedManifest } from "./packed-manifest.mjs";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const bundle = await readFile(join(root, "dist", "index.js"), "utf8");
const pnpm = resolvePnpmInvocation();
const packDirectory = await mkdtemp(join(tmpdir(), "weldall-package-verification-"));
let packed;
try {
  packed = JSON.parse(
    execFileSync(
      pnpm.command,
      [...pnpm.prefix, "pack", "--json", "--pack-destination", packDirectory],
      { cwd: root, encoding: "utf8", windowsHide: true },
    ),
  );
  readPackedManifest(packed.filename);
} finally {
  await rm(packDirectory, { recursive: true, force: true });
}
const files = packed.files.map(({ path }) => path).sort();

assert.equal(packageJson.name, "@weldall/cli");
assert.equal(packageJson.private, undefined);
assert.deepEqual(packageJson.os, ["darwin", "linux", "win32"]);
assert.equal(packageJson.engines?.node, ">=22.15.0");
assert.equal(packageJson.bin?.weldall, "dist/index.js");
assert.equal(packageJson.publishConfig?.access, "public");
assert.deepEqual(files, ["LICENSE", "README.md", "dist/index.js", "package.json"]);
assert.equal(packageJson.dependencies?.["@weldall/sdk"], undefined);
assert.match(bundle, /^#!\/usr\/bin\/env -S node --use-system-ca\n/);
assert.match(bundle, /import\("@napi-rs\/keyring"\)/);
assert.equal(packageJson.optionalDependencies?.["@napi-rs/keyring"], "1.3.0");
assert.doesNotMatch(bundle, /@weldall\/oauth/);
assert.doesNotMatch(bundle, /(?:from|import\()\s*["']@weldall\/sdk/);
assert.doesNotMatch(bundle, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
if (process.platform !== "win32") await access(join(root, "dist", "index.js"), constants.X_OK);

console.log(`Verified pnpm publication artifact ${packed.name}: ${files.join(", ")}`);
