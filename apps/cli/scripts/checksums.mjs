import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalOutputDirectory } from "./output-paths.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function writeSha256Sums(paths, outputPath) {
  const outputDirectory = await canonicalOutputDirectory(
    dirname(outputPath),
    repositoryRoot,
    "SHA256SUMS output",
  );
  const canonicalOutputPath = join(outputDirectory, basename(outputPath));
  const files = [...paths].sort((left, right) =>
    basename(left).localeCompare(basename(right), "en"),
  );
  const names = files.map((path) => basename(path));
  if (new Set(names).size !== names.length)
    throw new Error("Checksum input basenames must be unique");
  const lines = await Promise.all(
    files.map(async (path) => `${await sha256(path)}  ${basename(path)}`),
  );
  await writeFile(canonicalOutputPath, `${lines.join("\n")}\n`, { flag: "wx" });
  return canonicalOutputPath;
}

export async function verifySha256Sums(checksumPath) {
  const source = await readFile(checksumPath, "utf8");
  const lines = source.trim().split("\n");
  if (!source.endsWith("\n") || lines.some((line) => !/^[0-9a-f]{64}  [^/\\]+$/.test(line)))
    throw new Error("SHA256SUMS has an invalid format");
  const seen = new Set();
  for (const line of lines) {
    const [expected, name] = line.split("  ");
    if (seen.has(name)) throw new Error(`SHA256SUMS contains duplicate ${name}`);
    seen.add(name);
    const actual = await sha256(join(dirname(checksumPath), name));
    if (actual !== expected) throw new Error(`Checksum mismatch for ${name}`);
  }
  return [...seen];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") {
    const outputIndex = args.indexOf("--output");
    const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
    const files = args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1);
    if (!output || files.length === 0)
      throw new Error("Usage: node checksums.mjs create --output /path/SHA256SUMS <archives...>");
    console.log(await writeSha256Sums(files, output));
  } else if (command === "verify") {
    if (args.length !== 1) throw new Error("Usage: node checksums.mjs verify /path/SHA256SUMS");
    console.log(`Verified ${(await verifySha256Sums(args[0])).join(", ")}`);
  } else throw new Error("Expected create or verify");
}
