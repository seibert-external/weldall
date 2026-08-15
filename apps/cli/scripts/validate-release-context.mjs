import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliReleaseTag } from "./release-upload.mjs";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1];
if (!tag) throw new Error("Usage: node validate-release-context.mjs --tag @weldall/cli@X.Y.Z");
const version = parseCliReleaseTag(tag);
const packageJson = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
if (packageJson.name !== "@weldall/cli")
  throw new Error(`Expected package name @weldall/cli, got ${JSON.stringify(packageJson.name)}`);
if (packageJson.version !== version)
  throw new Error(
    `Release tag version ${version} differs from package version ${packageJson.version}`,
  );
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${version}\n`);
console.log(`Validated release identity ${tag} against @weldall/cli ${version}`);
