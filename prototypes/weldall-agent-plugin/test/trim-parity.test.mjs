import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { trimCatalog } from "../scripts/measure-catalog.mjs";

const jq = (program, payload) =>
  JSON.parse(
    execFileSync("jq", ["-c", program], { input: JSON.stringify(payload), encoding: "utf8" }),
  );

// jq is a system binary, not a package dependency, so this file adds nothing to install. It
// skips where jq is absent rather than failing, because prototypes/ has no dependency manifest
// to declare it in.
let jqInstalled = true;
try {
  execFileSync("jq", ["--version"], { stdio: "ignore" });
} catch {
  jqInstalled = false;
}

const procedure = await readFile(join(import.meta.dirname, "..", "procedure.md"), "utf8");
const lookupBlock = procedure.match(/<!-- lookup -->\n([\s\S]*?)<!-- \/lookup -->/)?.[1] ?? "";
const jqProgram = lookupBlock.match(/\| jq -c '([\s\S]*?)'\n/)?.[1];

const payloads = {
  "the committed fixture": JSON.parse(
    await readFile(join(import.meta.dirname, "fixtures", "skills-list.json"), "utf8"),
  ),
  // The case the fixture cannot carry without loosening the assertions pinned to it: a skill
  // published by an administrator rather than discovered from a resource, carrying neither tags
  // nor missing scopes.
  "an admin-published skill with no tags": {
    warnings: [],
    items: [
      {
        slug: "parity.admin",
        title: "Admin published",
        preview: "No meta, no missing scopes, published by an administrator.",
        available: true,
        requiredScopes: ["parity:read"],
        visibility: "listed",
        missingScopes: [],
        updatedAt: "2026-09-01T00:00:00.000Z",
        source: { type: "admin" },
      },
    ],
  },
};

test("the procedure ships a jq program inside its lookup block", () => {
  assert.ok(jqProgram, "the lookup block must hold a `jq -c '<program>'` command on one line");
});

for (const [name, payload] of Object.entries(payloads)) {
  test(`the jq lookup and trimCatalog agree on ${name}`, { skip: !jqInstalled }, () => {
    assert.deepEqual(jq(jqProgram, payload), trimCatalog(payload));
  });
}
