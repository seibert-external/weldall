#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePackages, sortReleaseEntries } from "./packages.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifactDirectory = resolve(root, process.argv[2] ?? ".release-artifacts");
const planPath = resolve(root, process.argv[3] ?? ".release-plan.json");
const npmRegistryUrl = (process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org").replace(
  /\/$/,
  "",
);
const packageByName = new Map(releasePackages.map((entry) => [entry.name, entry]));

const safeEnvironment = { ...process.env };
for (const name of [
  "FORGEJO_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "RELEASE_BOT_TOKEN",
])
  delete safeEnvironment[name];

const exec = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: safeEnvironment,
  });

const packageMetadata = async (name, version) => {
  const response = await fetch(
    `${npmRegistryUrl}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(
      `npm registry lookup for ${name}@${version} failed with HTTP ${response.status}`,
    );
  return response.json();
};

const requestedManifests = process.env.RELEASE_MANIFEST_FILE
  ? readFileSync(resolve(root, process.env.RELEASE_MANIFEST_FILE), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
  : process.env.RELEASE_MANIFESTS
    ? process.env.RELEASE_MANIFESTS.split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : readdirSync(join(root, ".releases"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => `.releases/${name}`);
const manifestPaths = requestedManifests.sort().map((relativePath) => {
  if (!/^\.releases\/release-[0-9a-f]{12}\.json$/.test(relativePath))
    throw new Error(`Invalid release manifest path: ${relativePath}`);
  return join(root, relativePath);
});
const seenVersions = new Set();
const plan = [];

rmSync(artifactDirectory, { recursive: true, force: true });
mkdirSync(artifactDirectory, { recursive: true });

for (const manifestPath of manifestPaths) {
  const relativeManifest = `.releases/${basename(manifestPath)}`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages))
    throw new Error(`Invalid release manifest: ${relativeManifest}`);
  const targetCommit = exec(
    "git",
    ["log", "--first-parent", "--format=%H", "--diff-filter=A", "-1", "--", relativeManifest],
    { capture: true },
  ).trim();
  if (!/^[0-9a-f]{40,64}$/.test(targetCommit))
    throw new Error(`Cannot determine release commit for ${relativeManifest}`);

  const entries = [];
  for (const candidate of manifest.packages) {
    const configured = packageByName.get(candidate.name);
    if (
      !configured ||
      candidate.directory !== configured.directory ||
      candidate.tag !== `${configured.tagPrefix}${candidate.version}` ||
      typeof candidate.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.version) ||
      candidate.version === "0.0.0"
    )
      throw new Error(`Invalid package entry in ${relativeManifest}`);
    const key = `${candidate.name}@${candidate.version}`;
    if (seenVersions.has(key)) throw new Error(`Duplicate release manifest entry: ${key}`);
    seenVersions.add(key);
    const metadata = await packageMetadata(candidate.name, candidate.version);
    entries.push({
      ...candidate,
      manifest: relativeManifest,
      targetCommit,
      published: metadata !== undefined,
      remoteIntegrity: metadata?.dist?.integrity,
    });
  }

  if (entries.length > 0) {
    const temporary = mkdtempSync(join(tmpdir(), "weldall-release-worktree-"));
    const worktree = join(temporary, "repository");
    let worktreeAdded = false;
    try {
      exec("git", ["worktree", "add", "--detach", worktree, targetCommit]);
      worktreeAdded = true;
      exec("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree });
      for (const entry of entries) {
        exec("pnpm", ["--filter", entry.name, "build"], { cwd: worktree });
        exec("pnpm", ["--filter", entry.name, "pack:check"], { cwd: worktree });
        const before = new Set(readdirSync(artifactDirectory));
        exec("pnpm", ["pack", "--pack-destination", artifactDirectory], {
          cwd: join(worktree, entry.directory),
        });
        const created = readdirSync(artifactDirectory).filter(
          (name) => name.endsWith(".tgz") && !before.has(name),
        );
        if (created.length !== 1) throw new Error(`Expected one tarball for ${entry.name}`);
        const tarball = join(artifactDirectory, created[0]);
        const packedManifest = JSON.parse(
          exec("tar", ["-xOzf", tarball, "package/package.json"], { capture: true }),
        );
        if (packedManifest.name !== entry.name || packedManifest.version !== entry.version)
          throw new Error(`Packed manifest mismatch for ${entry.name}@${entry.version}`);
        const integrity = `sha512-${createHash("sha512")
          .update(readFileSync(tarball))
          .digest("base64")}`;
        if (entry.published && entry.remoteIntegrity !== integrity)
          throw new Error(
            `Published tarball integrity mismatch for ${entry.name}@${entry.version}`,
          );
        entry.tarball = tarball;
        entry.integrity = integrity;
        delete entry.remoteIntegrity;
      }
    } finally {
      if (worktreeAdded)
        execFileSync("git", ["worktree", "remove", "--force", worktree], {
          cwd: root,
          stdio: "ignore",
        });
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  plan.push(...entries);
}

const firstParentCommits = exec("git", ["rev-list", "--first-parent", "--reverse", "HEAD"], {
  capture: true,
})
  .trim()
  .split("\n")
  .filter(Boolean);
sortReleaseEntries(plan, firstParentCommits);

writeFileSync(planPath, `${JSON.stringify({ schemaVersion: 1, packages: plan }, null, 2)}\n`);
console.log(`Prepared ${plan.length} release entries in ${planPath}`);
for (const entry of plan)
  console.log(
    `${entry.name}@${entry.version}: ${entry.published ? "already published" : entry.tarball}`,
  );
