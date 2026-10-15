import { build } from "esbuild";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  entryPoints: [root + "src/index.ts"],
  outfile: root + "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.15",
  packages: "external",
  // Bundle our unpublished workspace contracts; only pinned public packages remain external.
  alias: {
    "@weldall/sdk/mcp": fileURLToPath(
      new URL("../../../packages/sdk/src/mcp/index.ts", import.meta.url),
    ),
  },
});
await chmod(root + "dist/index.js", 0o755);
const pkg = JSON.parse(await readFile(root + "package.json", "utf8"));
await writeFile(
  root + "dist/server.json",
  JSON.stringify(
    {
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: pkg.mcpName,
      title: "Weldall",
      version: pkg.version,
      description: "Skills and governed API tools. Requires the local Weldall binary in PATH.",
      repository: {
        url: "https://github.com/seibert-external/weldall",
        source: "github",
        subfolder: "apps/goose-extension",
      },
      packages: [
        {
          registryType: "npm",
          identifier: pkg.name,
          version: pkg.version,
          transport: { type: "stdio" },
          runtimeHint: "npx",
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
