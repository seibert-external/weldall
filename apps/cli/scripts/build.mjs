import { chmod, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { packageInputsPlugin } from "./package-inputs-plugin.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "index.js");
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
  plugins: [packageInputsPlugin(version, "npm")],
});
await chmod(output, 0o755);
