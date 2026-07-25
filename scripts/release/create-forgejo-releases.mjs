#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const planPath = resolve(root, process.argv[2] ?? ".release-plan.json");
const serverUrl = process.env.FORGEJO_SERVER_URL?.replace(/\/$/, "");
const repository = process.env.FORGEJO_REPOSITORY;
const token = process.env.RELEASE_BOT_TOKEN;
const npmRegistryUrl = (process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org").replace(
  /\/$/,
  "",
);
if (!serverUrl || !repository || !token)
  throw new Error("FORGEJO_SERVER_URL, FORGEJO_REPOSITORY, and RELEASE_BOT_TOKEN are required");

const plan = JSON.parse(readFileSync(planPath, "utf8"));
if (plan.schemaVersion !== 1 || !Array.isArray(plan.packages))
  throw new Error("Invalid prepared release plan");

const forgejoRequest = async (path, options = {}, allowNotFound = false) => {
  const response = await fetch(`${serverUrl}/api/v1/repos/${repository}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      authorization: `token ${token}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Forgejo API ${options.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.status === 204 ? undefined : response.json();
};

const packageMetadata = async (name, version) => {
  const response = await fetch(
    `${npmRegistryUrl}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok)
    throw new Error(`${name}@${version} is not available from npm (HTTP ${response.status})`);
  return response.json();
};

const releaseNotes = (entry) => {
  let changelog = "";
  try {
    changelog = execFileSync(
      "git",
      ["show", `${entry.targetCommit}:${entry.directory}/CHANGELOG.md`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    // The npm link below is sufficient when a package has no changelog yet.
  }
  const escaped = entry.version.replaceAll(".", "\\.");
  const match = changelog.match(
    new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m"),
  );
  return (
    match?.[1]?.trim() ??
    `Published [${entry.name}@${entry.version}](https://www.npmjs.com/package/${entry.name}/v/${entry.version}).`
  );
};

for (const entry of plan.packages) {
  if (
    typeof entry.name !== "string" ||
    typeof entry.version !== "string" ||
    entry.version === "0.0.0" ||
    typeof entry.tag !== "string" ||
    typeof entry.targetCommit !== "string" ||
    typeof entry.integrity !== "string"
  )
    throw new Error("Invalid package entry in prepared release plan");
  const metadata = await packageMetadata(entry.name, entry.version);
  if (metadata.dist?.integrity !== entry.integrity)
    throw new Error(`Published tarball integrity mismatch for ${entry.name}@${entry.version}`);

  const existingTag = await forgejoRequest(`/tags/${encodeURIComponent(entry.tag)}`, {}, true);
  const existingTarget = existingTag?.commit?.sha ?? existingTag?.commit?.id;
  if (existingTag && existingTarget !== entry.targetCommit) {
    throw new Error(
      `Existing tag ${entry.tag} points to ${existingTarget ?? "an unknown commit"}, expected ${entry.targetCommit}`,
    );
  }
  const existingRelease = await forgejoRequest(
    `/releases/tags/${encodeURIComponent(entry.tag)}`,
    {},
    true,
  );
  if (existingRelease) {
    if (!existingTag)
      throw new Error(`Forgejo release ${entry.tag} exists without a repository tag`);
    console.log(`Forgejo release already exists: ${entry.tag}`);
    continue;
  }

  const release = await forgejoRequest("/releases", {
    method: "POST",
    body: JSON.stringify({
      tag_name: entry.tag,
      target_commitish: entry.targetCommit,
      name: `${entry.name}@${entry.version}`,
      body: releaseNotes(entry),
      draft: false,
      prerelease: entry.version.includes("-"),
    }),
  });
  const createdTag = await forgejoRequest(`/tags/${encodeURIComponent(entry.tag)}`);
  const createdTarget = createdTag.commit?.sha ?? createdTag.commit?.id;
  if (createdTarget !== entry.targetCommit) {
    throw new Error(
      `Created tag ${entry.tag} points to ${createdTarget}, expected ${entry.targetCommit}`,
    );
  }
  console.log(`Created tag and Forgejo release: ${release.html_url ?? entry.tag}`);
}
