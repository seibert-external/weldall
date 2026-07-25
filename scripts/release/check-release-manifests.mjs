#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { releasePackages } from "./packages.mjs";

const base = process.argv[2] ?? process.env.CHANGE_BASE_SHA;
if (!base) throw new Error("A merge-base SHA is required to validate release manifests");

const changes = execFileSync(
  "git",
  ["diff", "--name-status", "--no-renames", `${base}...HEAD`, "--", ".releases/*.json"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [status, path] = line.split("\t");
    return { status, path };
  });

const rewritten = changes.filter(({ status }) => status !== "A");
if (rewritten.length > 0) {
  throw new Error(
    `Release manifests are immutable and may only be added:\n${rewritten
      .map(({ status, path }) => `  ${status} ${path}`)
      .join("\n")}`,
  );
}
const packageByName = new Map(releasePackages.map((entry) => [entry.name, entry]));
for (const { path } of changes) {
  if (!/^\.releases\/release-[0-9a-f]{12}\.json$/.test(path))
    throw new Error(`Invalid release manifest path: ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 12);
  if (path !== `.releases/release-${digest}.json`)
    throw new Error(`Release manifest filename does not match its content: ${path}`);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages))
    throw new Error(`Invalid release manifest: ${path}`);
  const seen = new Set();
  for (const entry of manifest.packages) {
    const configured = packageByName.get(entry.name);
    if (
      !configured ||
      entry.directory !== configured.directory ||
      typeof entry.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version) ||
      entry.version === "0.0.0" ||
      entry.tag !== `${configured.tagPrefix}${entry.version}` ||
      seen.has(entry.name)
    )
      throw new Error(`Invalid package entry in ${path}`);
    seen.add(entry.name);
  }
}
console.log(`Validated ${changes.length} added immutable release manifest(s).`);
