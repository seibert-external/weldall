// Bundles the Git app into one ES module for the Docker image, plus the license texts of every
// package that ends up in the bundle. The runtime image then needs Node.js and these two files
// only: no package manager, no node_modules, and no workspace peer dependencies (a pnpm deploy
// of this workspace installs the SDK's optional peers, several hundred MB).
//
//   node scripts/build-image.mjs [out-directory]   (default dist/image)
//
// Writes <out>/index.mjs and <out>/THIRD_PARTY_NOTICES. The @weldall/sdk build (tsc) must exist.
// Fails when a bundled package has no license file, so the image never ships code without its
// notice.

import { build } from "esbuild";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDirectory = resolve(appRoot, process.argv[2] ?? "dist/image");
const licenseName = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

const result = await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/index.ts"],
  outfile: join(outDirectory, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // CommonJS dependencies call require() for Node built-ins; an ES module has none of its own.
  banner: {
    js: "import { createRequire as __weldallCreateRequire } from 'node:module';\nconst require = __weldallCreateRequire(import.meta.url);",
  },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

/** The package directory (nearest package.json with a name) of a bundled file in node_modules. */
async function packageOf(file) {
  let directory = dirname(file);
  while (directory.includes("node_modules")) {
    try {
      const json = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (typeof json.name === "string") return { directory, json };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  return undefined;
}

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules")) continue;
  const found = await packageOf(resolve(appRoot, input));
  if (!found) throw new Error(`No package.json for bundled file ${input}`);
  // Workspace packages (the SDK) are this repository's own code under its license.
  if (found.json.name.startsWith("@weldall/")) continue;
  packages.set(`${found.json.name}@${found.json.version}`, found);
}

const sections = [];
for (const [id, { directory, json }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const files = (await readdir(directory)).filter((name) => licenseName.test(name)).sort();
  if (files.length === 0) throw new Error(`Bundled package ${id} has no license file`);
  const texts = await Promise.all(
    files.map(async (name) =>
      (await readFile(join(directory, name), "utf8")).replace(/\r\n?/g, "\n").trim(),
    ),
  );
  sections.push(
    `${id}\nLicense: ${typeof json.license === "string" ? json.license : "see below"}\n\n${texts.join("\n\n")}`,
  );
}

await mkdir(outDirectory, { recursive: true });
await writeFile(
  join(outDirectory, "THIRD_PARTY_NOTICES"),
  `The Weldall Git app image bundles the following third-party packages.\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
);
console.log(`Bundled ${packages.size} third-party packages into ${outDirectory}/index.mjs`);
