import { readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pathDebrisPatterns = [
  /(^|\/)\.bun-build(\/|$)/,
  /(^|\/)(?:executables|archives|package-temp|packaging-temp)(\/|$)/,
];
const fileDebrisPatterns = [
  /(?:\.tar\.gz|\.tgz|\.zip)$/i,
  /(^|\/)SHA256SUMS$/,
  /(^|\/)weldall(?:\.exe)?$/,
  /(^|\/)\.weldall-[^/]*\.tmp$/,
];

function allowedDirectory(path) {
  if (path === ".git" || path === "node_modules" || path === ".turbo") return true;
  return /^(?:apps|packages|tooling|examples)\/[^/]+(?:\/[^/]+)*\/(?:\.turbo|\.cache)$/.test(path);
}

export async function findPackageDebris(root = repositoryRoot) {
  const debris = [];
  const walk = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        pathDebrisPatterns.some((pattern) => pattern.test(path)) ||
        (!entry.isDirectory() && fileDebrisPatterns.some((pattern) => pattern.test(path)))
      ) {
        debris.push(path);
        continue;
      }
      if (entry.isDirectory() && !allowedDirectory(path))
        await walk(resolve(directory, entry.name), path);
    }
  };
  await walk(resolve(root));
  return debris.sort((left, right) => left.localeCompare(right, "en"));
}

export async function assertNoPackageDebris(root = repositoryRoot) {
  const debris = await findPackageDebris(root);
  if (debris.length)
    throw new Error(
      `Repository packaging debris detected:\n${debris.map((path) => `- ${path}`).join("\n")}`,
    );
  return debris;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await assertNoPackageDebris();
  const relativeRoot = relative(process.cwd(), repositoryRoot) || ".";
  console.log(`No standalone/package debris in ${relativeRoot.split(sep).join("/")}`);
}
