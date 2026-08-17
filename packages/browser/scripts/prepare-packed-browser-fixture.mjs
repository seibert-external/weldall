import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

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
const viteVersion = JSON.parse(
  await readFile(join(root, "node_modules/vite/package.json"), "utf8"),
).version;
await writeFile(
  join(fixture, "package.json"),
  JSON.stringify({ private: true, type: "module", scripts: { build: "vite build" } }, null, 2),
);
// A nested workspace boundary keeps this disposable clean consumer out of the
// repository lockfile while still allowing an offline pnpm install.
await writeFile(join(fixture, "pnpm-workspace.yaml"), "packages: []\n");
const install = spawnSync(
  "pnpm",
  ["add", "--offline", "--ignore-scripts", join(artifacts, tarball), `vite@${viteVersion}`],
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
