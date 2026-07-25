#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? process.env.CHANGE_BASE_SHA;
const generatedReleasePr = process.env.CHANGE_RELEASE_PR === "true";

if (generatedReleasePr) {
  console.log("Release PR consumes change intents; intent enforcement is skipped.");
  process.exit(0);
}
if (!base) {
  throw new Error("A merge-base SHA is required as the first argument or CHANGE_BASE_SHA");
}

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean);

const changedFiles = git(
  "diff",
  "--name-only",
  "--no-renames",
  "--diff-filter=ACMD",
  `${base}...HEAD`,
);
const intentFiles = git(
  "diff",
  "--name-only",
  "--diff-filter=AM",
  `${base}...HEAD`,
  "--",
  ".changeset/*.md",
);

const publishPaths = [
  { prefix: "packages/sdk/", packageName: "@weldall/sdk" },
  { prefix: "apps/cli/", packageName: "@weldall/ci" },
];
const requiredPackages = new Set(
  publishPaths
    .filter(({ prefix }) => changedFiles.some((file) => file.startsWith(prefix)))
    .map(({ packageName }) => packageName),
);

if (requiredPackages.size === 0) {
  console.log("No publishable SDK or CLI paths changed; no change intent is required.");
  process.exit(0);
}

const declaredPackages = new Map();
for (const file of intentFiles) {
  const contents = readFileSync(file, "utf8");
  const [, frontmatter = ""] = contents.split("---", 3);
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^\s*["']?(@?[^"']+?)["']?\s*:\s*(none|patch|minor|major)\s*$/);
    if (match) declaredPackages.set(match[1], { bump: match[2], file });
  }
}

const missing = [...requiredPackages].filter((packageName) => !declaredPackages.has(packageName));
if (missing.length > 0) {
  const suggestions = missing
    .map(
      (packageName) =>
        `  pnpm change --bump <none|patch|minor|major> --summary "Describe the change" ${packageName}`,
    )
    .join("\n");
  throw new Error(
    `Publishable paths changed without a matching change intent for: ${missing.join(", ")}\n` +
      `Add an intent in this pull request, including an explicit none intent when no release is needed:\n${suggestions}`,
  );
}

for (const packageName of requiredPackages) {
  const declaration = declaredPackages.get(packageName);
  console.log(`${packageName}: ${declaration.bump} (${declaration.file})`);
}
