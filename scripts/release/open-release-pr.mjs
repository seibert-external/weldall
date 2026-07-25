#!/usr/bin/env node

import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const serverUrl = process.env.FORGEJO_SERVER_URL?.replace(/\/$/, "");
const repository = process.env.FORGEJO_REPOSITORY;
const token = process.env.RELEASE_BOT_TOKEN;
const branch = process.env.RELEASE_BRANCH ?? "release/pnpm";
const base = process.env.RELEASE_BASE ?? "main";
const planFile = process.env.RELEASE_PLAN_FILE;

if (!serverUrl || !repository) {
  throw new Error("FORGEJO_SERVER_URL and FORGEJO_REPOSITORY are required");
}
if (!dryRun && !token) throw new Error("RELEASE_BOT_TOKEN is required");

const plan = planFile ? readFileSync(planFile, "utf8").trim() : "See the committed changelogs.";
const title = "chore(release): version packages";
const body = [
  "Automated release PR generated from pnpm native change intents.",
  "",
  "Merging this PR consumes the pending intents. After CI and E2E pass, the merge publishes every new public package version to npm and creates package-specific Forgejo releases.",
  "",
  "<details><summary>Release plan</summary>",
  "",
  "```text",
  plan,
  "```",
  "</details>",
].join("\n");

const payload = { base, head: branch, title, body };
if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const apiBase = `${serverUrl}/api/v1/repos/${repository}`;
const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      authorization: `token ${token}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Forgejo API ${options.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.status === 204 ? undefined : response.json();
};

const pulls = await request("/pulls?state=open&limit=50");
const existing = pulls.find(
  (pull) =>
    (pull.head?.ref === branch || pull.head?.label?.endsWith(`:${branch}`)) &&
    pull.base?.ref === base,
);
if (existing) {
  await request(`/pulls/${existing.number}`, {
    method: "PATCH",
    body: JSON.stringify({ title, body }),
  });
  console.log(`Updated release PR #${existing.number}: ${existing.html_url}`);
} else {
  const created = await request("/pulls", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  console.log(`Created release PR #${created.number}: ${created.html_url}`);
}
