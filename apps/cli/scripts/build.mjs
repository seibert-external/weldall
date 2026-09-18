import { chmod, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { packageInputsPlugin } from "./package-inputs-plugin.mjs";
import { assertNoTestHooksInArtifact, assertTestHooksInArtifact } from "./test-hook-artifact.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const e2e = process.argv.slice(2).includes("--e2e");
if (process.argv.length > (e2e ? 3 : 2)) throw new Error("Usage: node scripts/build.mjs [--e2e]");
const output = join(root, "dist", ...(e2e ? ["e2e", "index.js"] : ["index.js"]));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.15",
  packages: "external",
  define: { __WELDALL_TEST_BUILD__: String(e2e) },
  minifySyntax: true,
  plugins: [packageInputsPlugin(version, "npm")],
});
await chmod(output, 0o755);
if (e2e) await assertTestHooksInArtifact(output);
else await assertNoTestHooksInArtifact(output);
