import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export const dependencySections = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const localProtocol = /^(?:catalog:|file:|link:|workspace:)/;

export function assertPublishableManifest(manifest) {
  assert.equal(manifest.name, "@weldall/cli");
  assert.deepEqual(manifest.os, ["darwin", "linux", "win32"]);
  for (const section of dependencySections) {
    const dependencies = manifest[section] ?? {};
    assert.equal(
      typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies),
      true,
      `${section} must be an object`,
    );
    for (const [name, specifier] of Object.entries(dependencies)) {
      assert.equal(typeof specifier, "string", `${section}.${name} must be a string`);
      assert.doesNotMatch(
        specifier,
        localProtocol,
        `${section}.${name} must not use a repository-local protocol`,
      );
    }
  }
  return manifest;
}

export function readPackedManifest(tarball, spawn = spawnSync) {
  const result = spawn("tar", ["-xOf", tarball, "package/package.json"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error)
    throw new Error(`Unable to inspect packed manifest in ${tarball}`, { cause: result.error });
  if (result.status !== 0)
    throw new Error(
      `Unable to inspect packed manifest in ${tarball}: ${result.stderr || result.stdout}`,
    );
  return assertPublishableManifest(JSON.parse(result.stdout));
}
