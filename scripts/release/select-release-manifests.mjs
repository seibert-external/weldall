#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePackages } from "./packages.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(root, process.argv[2] ?? ".release-manifests.txt");
const serverUrl = process.env.FORGEJO_SERVER_URL?.replace(/\/$/, "");
const repository = process.env.FORGEJO_REPOSITORY;
const token = process.env.RELEASE_BOT_TOKEN;
const npmRegistryUrl = (process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org").replace(
  /\/$/,
  "",
);
if (!serverUrl || !repository || !token)
  throw new Error("FORGEJO_SERVER_URL, FORGEJO_REPOSITORY, and RELEASE_BOT_TOKEN are required");
const packageByName = new Map(releasePackages.map((entry) => [entry.name, entry]));

const forgejoRequest = async (path, allowNotFound = false) => {
  const response = await fetch(`${serverUrl}/api/v1/repos/${repository}${path}`, {
    headers: { accept: "application/json", authorization: `token ${token}` },
  });
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Forgejo API GET ${path} failed with HTTP ${response.status}`);
  return response.json();
};

const packageExists = async (name, version) => {
  const response = await fetch(
    `${npmRegistryUrl}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(
      `npm registry lookup for ${name}@${version} failed with HTTP ${response.status}`,
    );
  return true;
};

const selected = [];
const manifestDirectory = join(root, ".releases");
for (const name of readdirSync(manifestDirectory)
  .filter((entry) => entry.endsWith(".json"))
  .sort()) {
  const relativePath = `.releases/${basename(name)}`;
  if (!/^\.releases\/release-[0-9a-f]{12}\.json$/.test(relativePath))
    throw new Error(`Invalid release manifest path: ${relativePath}`);
  const targetCommit = execFileSync(
    "git",
    ["log", "--first-parent", "--format=%H", "--diff-filter=A", "-1", "--", relativePath],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (!/^[0-9a-f]{40,64}$/.test(targetCommit))
    throw new Error(`Cannot determine release commit for ${relativePath}`);
  const manifest = JSON.parse(readFileSync(join(root, relativePath), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages))
    throw new Error(`Invalid release manifest: ${relativePath}`);

  let complete = true;
  for (const entry of manifest.packages) {
    const configured = packageByName.get(entry.name);
    if (
      !configured ||
      entry.directory !== configured.directory ||
      entry.tag !== `${configured.tagPrefix}${entry.version}` ||
      typeof entry.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version) ||
      entry.version === "0.0.0"
    )
      throw new Error(`Invalid package entry in ${relativePath}`);
    const tag = await forgejoRequest(`/tags/${encodeURIComponent(entry.tag)}`, true);
    const release = await forgejoRequest(`/releases/tags/${encodeURIComponent(entry.tag)}`, true);
    const tagTarget = tag?.commit?.sha ?? tag?.commit?.id;
    if (tag && tagTarget !== targetCommit)
      throw new Error(`Tag ${entry.tag} does not point to ${targetCommit}`);
    if (release && !tag) throw new Error(`Release ${entry.tag} exists without a repository tag`);
    if (!tag || !release || !(await packageExists(entry.name, entry.version))) complete = false;
  }
  if (!complete) selected.push(relativePath);
}

writeFileSync(output, selected.length ? `${selected.join("\n")}\n` : "");
console.log(`Selected ${selected.length} incomplete release manifest(s).`);
