#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareReleaseVersions } from "./packages.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const planPath = resolve(root, process.argv[2] ?? ".release-plan.json");
const npmRegistryUrl = (process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org").replace(
  /\/$/,
  "",
);
const npmToken = process.env.NODE_AUTH_TOKEN;
if (!npmToken) throw new Error("NODE_AUTH_TOKEN is required");

const plan = JSON.parse(readFileSync(planPath, "utf8"));
if (plan.schemaVersion !== 1 || !Array.isArray(plan.packages))
  throw new Error("Invalid prepared release plan");

const registryRequest = async (path) => {
  const response = await fetch(`${npmRegistryUrl}/${path}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry lookup failed with HTTP ${response.status}`);
  return response.json();
};

const packageMetadata = async (name, version) => {
  return registryRequest(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
};

const packageDocument = (name) => registryRequest(encodeURIComponent(name));

const publishEnvironment = { ...process.env };
for (const name of ["FORGEJO_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "RELEASE_BOT_TOKEN"])
  delete publishEnvironment[name];

for (const entry of plan.packages) {
  if (
    typeof entry.name !== "string" ||
    typeof entry.version !== "string" ||
    entry.version === "0.0.0" ||
    typeof entry.tarball !== "string" ||
    typeof entry.integrity !== "string"
  )
    throw new Error("Invalid package entry in prepared release plan");
  const tarball = resolve(root, entry.tarball);
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  if (packedManifest.name !== entry.name || packedManifest.version !== entry.version)
    throw new Error(`Prepared tarball manifest mismatch for ${entry.name}@${entry.version}`);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  if (integrity !== entry.integrity) throw new Error(`Prepared tarball changed: ${entry.name}`);

  const metadata = await packageMetadata(entry.name, entry.version);
  if (metadata) {
    if (metadata.dist?.integrity !== integrity)
      throw new Error(`Published tarball integrity mismatch for ${entry.name}@${entry.version}`);
    console.log(`${entry.name}@${entry.version} is already published with matching integrity.`);
    continue;
  }

  const temporaryTag = `weldall-release-${entry.version.replace(/[^0-9A-Za-z-]/g, "-")}`;
  execFileSync(
    "pnpm",
    [
      "publish",
      tarball,
      "--ignore-scripts",
      "--access",
      "public",
      "--no-git-checks",
      "--tag",
      temporaryTag,
    ],
    { cwd: root, stdio: "inherit", env: publishEnvironment },
  );
  const published = await packageMetadata(entry.name, entry.version);
  if (published?.dist?.integrity !== integrity)
    throw new Error(`npm did not retain the prepared tarball for ${entry.name}@${entry.version}`);
  console.log(`Published ${entry.name}@${entry.version}.`);
}

for (const entry of plan.packages) {
  const finalTag = entry.version.includes("-") ? "next" : "latest";
  const temporaryTag = `weldall-release-${entry.version.replace(/[^0-9A-Za-z-]/g, "-")}`;
  const document = await packageDocument(entry.name);
  const currentVersion = document?.["dist-tags"]?.[finalTag];
  if (!currentVersion || compareReleaseVersions(entry.version, currentVersion) > 0) {
    execFileSync("pnpm", ["dist-tag", "add", `${entry.name}@${entry.version}`, finalTag], {
      cwd: root,
      stdio: "inherit",
      env: publishEnvironment,
    });
  }
  if (document?.["dist-tags"]?.[temporaryTag] === entry.version) {
    execFileSync("pnpm", ["dist-tag", "rm", entry.name, temporaryTag], {
      cwd: root,
      stdio: "inherit",
      env: publishEnvironment,
    });
  }
}
