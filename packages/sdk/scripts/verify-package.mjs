import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "weldall-sdk-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", temp], {
    cwd: packageDir,
    stdio: "inherit",
  });
  const tarball = join(
    temp,
    readdirSync(temp).find((name) => name.endsWith(".tgz")),
  );
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
  assert.equal(packageJson.name, "@weldall/sdk");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, "Apache-2.0");
  assert.equal(packageJson.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [".", "./astro", "./hono", "./next"]);
  assert.equal(packageJson.engines.node, ">=22.15.0");
  assert.equal(JSON.stringify(packageJson).includes("workspace:"), false);
  assert.deepEqual(packageJson.peerDependencies, {
    astro: ">=7 <8",
    hono: ">=4 <5",
    next: ">=16 <17",
  });
  for (const required of [
    "package/README.md",
    "package/LICENSE",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/hono.js",
    "package/dist/next.js",
    "package/dist/astro.js",
  ])
    assert(listing.includes(required), `${required} is missing`);
  assert(
    !listing.some(
      (name) => name.includes("/src/") || name.includes("/test/") || name.includes(".env"),
    ),
    "source, tests, or environment files leaked into tarball",
  );
  console.log(`verified ${tarball}: ${listing.length} files`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
