// Helpers for .github/workflows/release-docker-images.yml.
//
//   node scripts/image-release.mjs validate --tag @weldall/weldall@1.2.3
//   node scripts/image-release.mjs plan-tags --repository weldall/weldall --version 1.2.3
//   node scripts/image-release.mjs check-image --image local:tag --unit weldall --platform linux/amd64 --version 1.2.3 --revision <sha>
//
// Every subcommand appends its results to $GITHUB_OUTPUT when that variable is set.

import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const imageReleaseUnits = {
  "@weldall/weldall": {
    image: "weldall",
    directory: "apps/weldall",
    context: ".",
    dockerfile: "Dockerfile",
    title: "Weldall",
    description:
      "Weldall server: OAuth authorization server and skill gateway for AI agents. Requires PostgreSQL.",
    entrypoint: ["./entrypoint.sh"],
  },
  "@weldall/discovery-proxy": {
    image: "discovery-proxy",
    directory: "apps/discovery-proxy",
    context: "apps/discovery-proxy",
    dockerfile: "apps/discovery-proxy/Dockerfile",
    title: "Weldall discovery proxy",
    description:
      "Unprivileged nginx exposing only the Weldall OAuth discovery document and JWKS of an upstream Weldall.",
    // Inherited from nginxinc/nginx-unprivileged; it runs docker-entrypoint.d/ including the upstream validator.
    entrypoint: ["/docker-entrypoint.sh"],
  },
};

export const imageReleaseUnitsByImage = Object.fromEntries(
  Object.values(imageReleaseUnits).map((unit) => [unit.image, unit]),
);

const tagPattern = /^(@weldall\/(?:weldall|discovery-proxy))@(\d+)\.(\d+)\.(\d+)$/;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseImageReleaseTag(tag) {
  const match = tagPattern.exec(tag);
  if (!match)
    throw new Error(
      `Expected an exact @weldall/weldall@X.Y.Z or @weldall/discovery-proxy@X.Y.Z release tag; got ${JSON.stringify(tag)}`,
    );
  const [, packageName, major, minor, patch] = match;
  return {
    packageName,
    version: `${major}.${minor}.${patch}`,
    ...imageReleaseUnits[packageName],
  };
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = versionPattern.exec(value);
    if (!match) throw new Error(`Expected an X.Y.Z version; got ${JSON.stringify(value)}`);
    return match.slice(1).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

// The exact version tag is always written. The floating tags only move forward:
// X.Y follows the highest patch of that minor line and latest follows the highest
// version overall, so re-releasing an older line never rolls a customer back.
export function planImageTags(version, publishedVersions) {
  if (!versionPattern.test(version))
    throw new Error(`Expected an X.Y.Z version; got ${JSON.stringify(version)}`);
  const published = publishedVersions.filter((value) => versionPattern.test(value));
  const [major, minor] = version.split(".");
  const sameMinor = published.filter((value) => value.startsWith(`${major}.${minor}.`));
  const isHighest = (candidates) =>
    candidates.every((candidate) => compareVersions(version, candidate) >= 0);
  const tags = [version];
  if (isHighest(sameMinor)) tags.push(`${major}.${minor}`);
  if (isHighest(published)) tags.push("latest");
  return tags;
}

// Docker Hub's public tag listing; a repository that does not exist yet answers 404.
// A private repository answers 404 as well, so this lookup assumes the image repositories
// stay public: for a private one it would report "nothing published" and let the floating
// tags move backwards.
export async function fetchPublishedVersions(repository, fetchImpl = fetch) {
  const versions = [];
  let url = `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100`;
  while (url) {
    // Docker Hub's edge rejects Node's default user agent with 403.
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "weldall-release-docker-images" },
    });
    if (response.status === 404) return versions;
    if (!response.ok)
      throw new Error(
        `Docker Hub tag listing for ${repository} failed with HTTP ${response.status}`,
      );
    const body = await response.json();
    for (const result of body.results ?? []) {
      if (versionPattern.test(result.name)) versions.push(result.name);
    }
    url = body.next ?? null;
  }
  return versions;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name} <value>`);
  return value;
}

async function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

// The repository license is the single source for the OCI licenses label: `validate`
// exports it for the build and `check-labels` reads it back.
async function repositoryLicense() {
  const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (typeof rootPackage.license !== "string" || rootPackage.license.length === 0)
    throw new Error("Root package.json declares no license");
  return rootPackage.license;
}

async function validate() {
  const tag = argument("tag");
  const unit = parseImageReleaseTag(tag);
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, unit.directory, "package.json"), "utf8"),
  );
  if (packageJson.name !== unit.packageName)
    throw new Error(
      `Expected package name ${unit.packageName} in ${unit.directory}, got ${JSON.stringify(packageJson.name)}`,
    );
  if (packageJson.version !== unit.version)
    throw new Error(
      `Release tag version ${unit.version} differs from ${unit.directory} package version ${packageJson.version}`,
    );
  await writeOutputs({
    tag,
    image: unit.image,
    version: unit.version,
    context: unit.context,
    dockerfile: unit.dockerfile,
    title: unit.title,
    description: unit.description,
    license: await repositoryLicense(),
  });
}

async function planTags() {
  const repository = argument("repository");
  const version = argument("version");
  const published = await fetchPublishedVersions(repository);
  const tags = planImageTags(version, published);
  const skipped = ["latest", version.split(".").slice(0, 2).join(".")].filter(
    (tag) => !tags.includes(tag),
  );
  if (skipped.length > 0)
    console.log(
      `Not moving ${skipped.join(", ")}: ${repository} already publishes a higher version than ${version}`,
    );
  await writeOutputs({ tags: tags.join(",") });
}

export function inspectImage(image) {
  const [inspected] = JSON.parse(
    execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }),
  );
  return {
    platform: `${inspected.Os}/${inspected.Architecture}`,
    entrypoint: inspected.Config?.Entrypoint ?? [],
    labels: inspected.Config?.Labels ?? {},
  };
}

// The OCI labels, platform and entrypoint the release promises, checked on the built
// image before it is saved for publishing.
export function checkImageProblems(inspected, { unit, platform, version, revision, license }) {
  const problems = [];
  if (inspected.platform !== platform)
    problems.push(`platform: expected ${platform}, got ${inspected.platform}`);
  if (JSON.stringify(inspected.entrypoint) !== JSON.stringify(unit.entrypoint))
    problems.push(
      `entrypoint: expected ${JSON.stringify(unit.entrypoint)}, got ${JSON.stringify(inspected.entrypoint)}`,
    );
  const expectedLabels = {
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.licenses": license,
    "org.opencontainers.image.source": "https://github.com/seibert-external/weldall",
    "org.opencontainers.image.title": unit.title,
  };
  for (const [name, value] of Object.entries(expectedLabels)) {
    if (inspected.labels[name] !== value)
      problems.push(
        `${name}: expected ${JSON.stringify(value)}, got ${JSON.stringify(inspected.labels[name])}`,
      );
  }
  if (!inspected.labels["org.opencontainers.image.created"])
    problems.push("org.opencontainers.image.created: missing");
  return problems;
}

async function checkImage() {
  const image = argument("image");
  const unit = imageReleaseUnitsByImage[argument("unit")];
  if (!unit)
    throw new Error(`Expected --unit <${Object.keys(imageReleaseUnitsByImage).join("|")}>`);
  const problems = checkImageProblems(inspectImage(image), {
    unit,
    platform: argument("platform"),
    version: argument("version"),
    revision: argument("revision"),
    license: await repositoryLicense(),
  });
  if (problems.length > 0) throw new Error(`Image ${image} is wrong:\n${problems.join("\n")}`);
  console.log(`Platform, entrypoint and OCI labels on ${image} verified`);
}

const commands = { validate, "plan-tags": planTags, "check-image": checkImage };
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const command = commands[process.argv[2]];
  if (!command)
    throw new Error(
      `Usage: node scripts/image-release.mjs <${Object.keys(commands).join("|")}> ...`,
    );
  await command();
}
