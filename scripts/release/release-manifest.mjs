#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePackages } from "./packages.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [command, snapshotPath] = process.argv.slice(2);
if (!snapshotPath || !["snapshot", "create"].includes(command)) {
  throw new Error("Usage: release-manifest.mjs <snapshot|create> <snapshot-file>");
}

const currentVersions = () =>
  Object.fromEntries(
    releasePackages.map(({ name, directory }) => {
      const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
      if (manifest.name !== name) throw new Error(`Unexpected package name in ${directory}`);
      return [name, manifest.version];
    }),
  );

if (command === "snapshot") {
  writeFileSync(snapshotPath, `${JSON.stringify(currentVersions(), null, 2)}\n`);
  console.log(`Saved release version snapshot: ${snapshotPath}`);
  process.exit(0);
}

const before = JSON.parse(readFileSync(snapshotPath, "utf8"));
const after = currentVersions();
const changed = releasePackages
  .filter(({ name }) => before[name] !== after[name])
  .map(({ name, directory, tagPrefix }) => ({
    name,
    version: after[name],
    directory,
    tag: `${tagPrefix}${after[name]}`,
  }));

if (changed.length === 0) {
  console.log("The release plan contains no public package version changes.");
  process.exit(0);
}
for (const entry of changed) {
  if (entry.version === "0.0.0") throw new Error(`${entry.name} cannot be released as 0.0.0`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version))
    throw new Error(`Invalid release version for ${entry.name}: ${entry.version}`);
}

const manifest = { schemaVersion: 1, packages: changed };
const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 12);
const directory = join(root, ".releases");
const path = join(directory, `release-${digest}.json`);
mkdirSync(directory, { recursive: true });
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`Created release manifest: ${basename(path)}`);
