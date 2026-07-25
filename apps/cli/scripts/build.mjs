import { chmod, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "index.js");
const sdkEntry = fileURLToPath(new URL("../../../packages/sdk/src/index.ts", import.meta.url));
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
  plugins: [
    {
      name: "weldall-package-inputs",
      setup(build) {
        build.onResolve({ filter: /^@weldall\/sdk$/ }, () => ({ path: sdkEntry }));
        build.onResolve({ filter: /^\.\.\/package\.json$/ }, () => ({
          path: "package-version",
          namespace: "weldall",
        }));
        build.onLoad({ filter: /^package-version$/, namespace: "weldall" }, () => ({
          contents: `export default ${JSON.stringify({ version })}`,
          loader: "js",
        }));
      },
    },
  ],
});
await chmod(output, 0o755);
