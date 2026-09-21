import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FRONTMATTER, HOSTS, assembleSkill, skillPath } from "../scripts/assemble-skill.mjs";

const root = join(import.meta.dirname, "..");
const read = (...parts) => readFile(join(root, ...parts), "utf8");
const manifestOf = (id) => read(HOSTS.find((host) => host.id === id).manifest);

test("every host ships the frontmatter plus procedure.md verbatim", async () => {
  const procedure = await read("procedure.md");
  for (const host of HOSTS) {
    const skill = await readFile(skillPath(host), "utf8");
    assert.equal(skill, assembleSkill(procedure), `run scripts/assemble-skill.mjs (${host.id})`);
    assert.ok(skill.endsWith(procedure), `the body must be procedure.md untouched (${host.id})`);
  }
});

test("the frontmatter survives being written as unquoted YAML", () => {
  assert.ok(!FRONTMATTER.description.includes(": "), "a colon would break the unquoted scalar");
  assert.ok(!FRONTMATTER.description.includes("\n"), "the description must be one line");
});

// pi refuses a skill name outside lowercase and hyphens and caps the description at 1024
// characters. Claude Code takes both without complaint, so the stricter host sets the limit
// for the one file they share.
test("the frontmatter stays inside the strictest host's limits", () => {
  assert.match(FRONTMATTER.name, /^[a-z][a-z0-9-]{0,63}$/u);
  assert.ok(
    FRONTMATTER.description.length <= 1024,
    `the description is ${FRONTMATTER.description.length} characters`,
  );
});

test("the description says what the skill does before it says when to use it", () => {
  const trigger = FRONTMATTER.description.indexOf("Use when ");
  assert.ok(trigger > 0, "the description must still carry a trigger");
  assert.ok(
    /^Routes a request about a company system/.test(FRONTMATTER.description),
    "a person browsing a list of skills reads this first, so it opens with what the skill does",
  );
});

test("the trigger decides from the request, never from a catalog", () => {
  assert.match(FRONTMATTER.description, /Use when the request concerns /);
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

test("the Claude Code manifest and the skill agree on the plugin name", async () => {
  const manifest = JSON.parse(await manifestOf("claude-code"));
  assert.equal(manifest.name, "weldall");
  assert.equal(FRONTMATTER.name, "weldall");
  assert.ok(manifest.description.length > 0);
});

// pi reads a package's skill directories from the pi key, and its gallery lists a package by
// the pi-package keyword. npm refuses a private package outright, and a scoped package defaults
// to restricted access, which fails without a paid org, so publishConfig has to say public.
test("the pi manifest declares its skills and publishes publicly", async () => {
  const manifest = JSON.parse(await manifestOf("pi"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.keywords.includes("pi-package"), "the gallery lists packages by this keyword");
  assert.ok(!("private" in manifest), "npm refuses to publish a private package");
  assert.equal(manifest.publishConfig.access, "public");
});

// The procedure carries no fallback to an older lookup flag: that was traded away deliberately,
// on the understanding that testers are told the floor out of band. This README is that telling,
// and it is the npm landing page, so the floor has to stay written down where they will land.
test("the pi README names the CLI version the lookup needs", async () => {
  const readme = await readFile(join(root, "hosts", "pi", "README.md"), "utf8");
  assert.match(readme, /0\.14\.0 or newer/);
  assert.match(readme, /weldall skills list --agentic/);
  assert.match(readme, /pi install npm:@weldall\/pi/);
});

// opencode never scans an installed package for skills. Measured against 1.18.4: a package whose
// only content was .opencode/skill/weldall/SKILL.md installed cleanly, logged nothing, and left
// the skill invisible to `opencode debug skill`. The directory is only read once something puts
// it on config.skills.paths, which is what plugin.js exists to do, so main has to point at it.
test("the opencode manifest ships the entry point that registers the skills", async () => {
  const manifest = JSON.parse(await manifestOf("opencode"));
  assert.equal(manifest.type, "module", "plugin.js uses import.meta.url");
  assert.equal(manifest.main, "plugin.js");
  for (const path of ["plugin.js", "skills"])
    assert.ok(manifest.files.includes(path), `npm would leave ${path} out of the tarball`);
  assert.ok(!("private" in manifest), "npm refuses to publish a private package");
  assert.equal(manifest.publishConfig.access, "public");
});

test("the opencode plugin puts its own skills directory on the config", async () => {
  const plugin = await read("hosts", "opencode", "plugin.js");
  assert.match(plugin, /config\.skills\.paths/);
  assert.match(plugin, /join\(dirname\(fileURLToPath\(import\.meta\.url\)\), "skills"\)/);
});

// Same reasoning as the pi README: the floor is told out of band, and this is the npm landing page.
test("the opencode README names the CLI version the lookup needs", async () => {
  const readme = await read("hosts", "opencode", "README.md");
  assert.match(readme, /0\.14\.0 or newer/);
  assert.match(readme, /weldall skills list --agentic/);
  assert.match(readme, /opencode plugin @weldall\/opencode/);
});

// OpenWork installs hosts/claude-code, not a host of its own. Its GitHub importer resolves a
// Claude Code plugin: it requires `.claude-plugin/plugin.json`, defaults its skill search to
// `<root>skills/**/SKILL.md`, and reads `.mcp.json` only `if (inTree(dotMcpPath))`, so having no
// MCP server costs nothing. Confirmed on 2026-09-21 by importing this directory from a branch URL
// into OpenWork 0.18.42: it wrote the one skill and recorded the source blob's own git sha.
//
// A vendor-neutral hosts/openwork/ wrapper built to the Agent Plugins 1.0.0 schema used to sit
// beside this, on the belief that OpenWork read that schema. Nothing ever consumed it, so it is
// gone. What this test pins is what OpenWork needs from hosts/claude-code: move either path and
// that install breaks with no failure here to warn you.
test("the Claude Code host keeps the layout OpenWork's importer requires", async () => {
  const claudeCode = HOSTS.find((host) => host.id === "claude-code");
  assert.equal(
    claudeCode.manifest,
    join("hosts", "claude-code", ".claude-plugin", "plugin.json"),
    "without this manifest the importer fails with plugin_manifest_not_found",
  );
  assert.equal(
    skillPath(claudeCode),
    join(root, "hosts", "claude-code", "skills", "weldall", "SKILL.md"),
    "the importer globs <root>skills/**/SKILL.md",
  );
  assert.ok(JSON.parse(await manifestOf("claude-code")).name, "the importer reads the name");
});

test("the hosts wrap one procedure, so they carry one version", async () => {
  const versions = await Promise.all(
    HOSTS.map(async (host) => JSON.parse(await read(host.manifest)).version),
  );
  for (const version of versions) assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.equal(new Set(versions).size, 1, `the host manifests disagree: ${versions.join(", ")}`);
});

test("the local marketplace points at the Claude Code host", async () => {
  const marketplace = JSON.parse(
    await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.name, "weldall");
  const entry = marketplace.plugins.find((plugin) => plugin.name === "weldall");
  assert.ok(entry, "marketplace.json must list the weldall plugin");
  assert.equal(entry.source, "./hosts/claude-code");
});
