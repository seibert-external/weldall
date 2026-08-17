import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const forbidden = [
  /\bnode:/u,
  /\bBuffer\b/u,
  /\bprocess\b/u,
  /\brequire\s*\(/u,
  /\b__dirname\b/u,
  /from\s+["'](?:crypto|fs|path|os|util|stream)["']/u,
];
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:js|d\.ts)$/u.test(entry.name)) files.push(path);
  }
}
await walk(join(root, "dist"));
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const pattern of forbidden)
    if (pattern.test(source))
      throw new Error(`${file} contains forbidden browser runtime pattern ${pattern}`);
}
const bundle = await build({
  entryPoints: [join(root, "dist/index.js")],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  metafile: true,
  logLevel: "silent",
});
for (const input of Object.keys(bundle.metafile.inputs))
  if (input.startsWith("node:") || ["crypto", "fs", "path", "os", "stream", "util"].includes(input))
    throw new Error(`Browser bundle contains Node builtin ${input}`);
console.log(`verified ${files.length} emitted browser files and the esbuild browser graph`);
