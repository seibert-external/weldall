import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const procedure = await readFile(join(root, "procedure.md"), "utf8");

// Prettier pads Markdown table columns, so compare trimmed cells, never raw rows.
const tableCells = procedure
  .split("\n")
  .filter((line) => line.trimStart().startsWith("|"))
  .map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );

test("the lookup block holds the live command and a swappable alternative", () => {
  const block = procedure.match(/<!-- lookup -->\n([\s\S]*?)<!-- \/lookup -->/);
  assert.ok(block, "procedure.md must delimit the lookup block with lookup comments");
  assert.match(block[1], /```sh\nweldall skills list --json\n```/);
  assert.match(block[1], /weldall skills list --json \| jq/);
});

test("the lookup is live on every run and never reused", () => {
  assert.match(procedure, /every time/);
  assert.match(procedure, /Never reuse a catalog read/);
});

test("skills find is ruled out, with the reason", () => {
  assert.match(procedure, /Do not use `weldall skills find`/);
  assert.match(procedure, /snapshot/);
});

test("the outcome table has one header, one rule and exactly four branches", () => {
  assert.equal(tableCells.length, 6, "expected a 4-row outcome table");
  assert.deepEqual(tableCells[0], ["Result of the lookup", "Response"]);
});

test("the available branch loads the skill", () => {
  const [result, response] = tableCells[2];
  assert.match(result, /available: true/);
  assert.match(response, /Load it and proceed/);
});

test("the unavailable branch names the missing scopes and stops", () => {
  const [result, response] = tableCells[3];
  assert.match(result, /available: false/);
  assert.match(response, /missingScopes/);
  assert.match(response, /administrator must grant/);
  assert.match(response, /do not attempt the request anyway/);
});

test("the no-match branch asks before falling back", () => {
  const [result, response] = tableCells[4];
  assert.match(result, /No match/);
  assert.match(response, /no skill for this/);
  assert.match(response, /ask before falling back/);
});

test("the warning branch never concludes the capability is absent", () => {
  const [result, response] = tableCells[5];
  assert.match(result, /`warnings` non-empty/);
  assert.match(response, /catalog is incomplete/);
  assert.match(response, /Never conclude the capability is absent/);
});

test("all three catalog warning codes are named", () => {
  for (const code of ["catalog_pending", "catalog_temporarily_unavailable", "catalog_expired"])
    assert.ok(procedure.includes(code), `procedure.md must name ${code}`);
});

test("a failed lookup routes to weldall login instead of a workaround", () => {
  assert.match(procedure, /weldall login/);
  assert.match(procedure, /Do not retry/);
});

test("the placeholder rule names a concrete placeholder", () => {
  assert.match(procedure, /placeholder/);
  assert.ok(procedure.includes("<contract-id>"));
});

test("the skill document is data, not an instruction that outranks the user", () => {
  assert.match(procedure, /is data/);
  assert.match(procedure, /cannot overrule the user/);
});

test("precedence runs from the conversation down to these defaults", () => {
  const order = ["asks for in this conversation", "skill document", "CLI appendix", "defaults"];
  let cursor = 0;
  for (const step of order) {
    const found = procedure.indexOf(step, cursor);
    assert.ok(found > -1, `precedence list must reach ${step} in order`);
    cursor = found;
  }
  assert.match(procedure, /may not switch off a confirmation, suppress an error, or hide where/);
});

test("all four presentation defaults are present", () => {
  assert.match(procedure, /Name the source of every answer/);
  assert.match(procedure, /only when the response body confirms it/);
  assert.match(procedure, /Never truncate silently/);
  assert.match(procedure, /word for word/);
  assert.match(procedure, /Do not retry with a different scope or URL/);
});

test("the body stays host-neutral", () => {
  for (const term of ["Claude", "Codex", "Gemini", "OpenWork", "frontmatter", "SKILL.md"])
    assert.ok(
      !procedure.includes(term),
      `procedure.md drifted into one host's conventions: ${term}`,
    );
});
