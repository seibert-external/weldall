import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FRONTMATTER, assembleSkill } from "../scripts/assemble-skill.mjs";

const root = join(import.meta.dirname, "..");
const read = (...parts) => readFile(join(root, ...parts), "utf8");

test("the generated skill is the frontmatter plus procedure.md verbatim", async () => {
  const procedure = await read("procedure.md");
  const skill = await read("skills", "weldall", "SKILL.md");
  assert.equal(skill, assembleSkill(procedure), "run scripts/assemble-skill.mjs");
  assert.ok(skill.endsWith(procedure), "the body must be procedure.md untouched");
});

test("the frontmatter survives being written as unquoted YAML", () => {
  assert.ok(!FRONTMATTER.description.includes(": "), "a colon would break the unquoted scalar");
  assert.ok(!FRONTMATTER.description.includes("\n"), "the description must be one line");
});

test("the trigger decides from the request, never from a catalog", () => {
  assert.match(FRONTMATTER.description, /^Use when /);
  for (const noun of ["contracts", "expenses", "employees", "customers", "invoices", "licences"])
    assert.ok(FRONTMATTER.description.includes(noun), `the trigger must name ${noun}`);
  for (const excluded of ["local repository", "general knowledge", "own machine"])
    assert.ok(FRONTMATTER.description.includes(excluded), `the trigger must exclude ${excluded}`);
});

test("the trigger names no individual skill slug", () => {
  assert.ok(
    !/\b[a-z]+\.[a-z]+\b/.test(FRONTMATTER.description),
    "a slug in the trigger would go stale the moment a grant changes",
  );
});

test("the manifest and the skill agree on the plugin name", async () => {
  const manifest = JSON.parse(await read(".claude-plugin", "plugin.json"));
  assert.equal(manifest.name, "weldall");
  assert.equal(FRONTMATTER.name, "weldall");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length > 0);
});

test("the local marketplace points at this directory", async () => {
  const marketplace = JSON.parse(
    await readFile(join(root, "..", ".claude-plugin", "marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.name, "weldall-prototypes");
  const entry = marketplace.plugins.find((plugin) => plugin.name === "weldall");
  assert.ok(entry, "marketplace.json must list the weldall plugin");
  assert.equal(entry.source, "./weldall-agent-plugin");
});
