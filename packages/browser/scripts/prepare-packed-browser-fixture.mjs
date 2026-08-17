import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const fixture = join(root, ".playwright-packed-fixture");
const artifacts = join(fixture, "artifacts");
await rm(fixture, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const packed = spawnSync("pnpm", ["pack", "--pack-destination", artifacts], {
  cwd: root,
  encoding: "utf8",
});
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
const tarball = (await readdir(artifacts)).find((name) => name.endsWith(".tgz"));
if (!tarball) throw new Error("pnpm pack did not create @weldall/browser tarball");
const vitePackagePath = join(root, "node_modules/vite/package.json");
const viteVersion = JSON.parse(await readFile(vitePackagePath, "utf8")).version;
const require = createRequire(await realpath(vitePackagePath));
const rollupPackage = JSON.parse(await readFile(require.resolve("rollup/package.json"), "utf8"));
const rollupNativePackage = Object.keys(rollupPackage.optionalDependencies).find((name) => {
  if (!name.startsWith("@rollup/rollup-")) return false;
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
});
if (!rollupNativePackage) throw new Error("could not resolve the installed Rollup native package");
await writeFile(
  join(fixture, "package.json"),
  JSON.stringify({ private: true, type: "module", scripts: { build: "vite build" } }, null, 2),
);
// A nested workspace boundary keeps this disposable clean consumer out of the
// repository lockfile while still allowing an offline pnpm install.
await writeFile(join(fixture, "pnpm-workspace.yaml"), "packages: []\n");
const install = spawnSync(
  "pnpm",
  [
    "add",
    "--offline",
    "--ignore-scripts",
    join(artifacts, tarball),
    `vite@${viteVersion}`,
    `${rollupNativePackage}@${rollupPackage.optionalDependencies[rollupNativePackage]}`,
  ],
  { cwd: fixture, encoding: "utf8" },
);
if (install.status !== 0) throw new Error(install.stderr || install.stdout);
await cp(join(root, "test/fixture/index.html"), join(fixture, "index.html"));
await cp(join(root, "test/fixture/main.ts"), join(fixture, "main.ts"));
await writeFile(
  join(fixture, "vite.config.js"),
  'import { defineConfig } from "vite"; export default defineConfig({ root: import.meta.dirname, build: { outDir: "dist", emptyOutDir: true } });\n',
);
const build = spawnSync("pnpm", ["exec", "vite", "build"], { cwd: fixture, encoding: "utf8" });
if (build.status !== 0) throw new Error(build.stderr || build.stdout);
console.log(`prepared packed production browser fixture at ${fixture}`);
