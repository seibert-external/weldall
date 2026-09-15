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

test("the lookup block holds exactly one command, and it is the live one", () => {
  const block = procedure.match(/<!-- lookup -->\n([\s\S]*?)<!-- \/lookup -->/);
  assert.ok(block, "procedure.md must delimit the lookup block with lookup comments");
  assert.match(block[1], /```sh\nweldall skills list --json\n```/);
  assert.equal(
    block[1].match(/```sh/gu)?.length,
    1,
    "a second command in the block leaves the agent to choose, and two testers then run different lookups",
  );
});

// The lookup must survive a machine without jq and a shell that is not POSIX: a quoted jq
// program does not reach the binary through cmd.exe, and jq is on neither a stock macOS nor a
// stock Windows install. Nothing in the procedure may hand the agent a pipeline to imitate.
test("the procedure names no shell tool the agent would have to have installed", () => {
  for (const tool of ["jq", "awk", "sed", "grep"])
    assert.ok(
      !new RegExp(`\\b${tool}\\b`, "u").test(procedure),
      `procedure.md still names ${tool}`,
    );
});

test("the agent is told to run the lookup unmodified", () => {
  assert.match(procedure, /exactly as written/);
  assert.match(procedure, /Do not append a filter, a search word, a pipeline/);
});

test("the lookup is live on every run and never reused", () => {
  assert.match(procedure, /every time/);
  assert.match(procedure, /Never reuse a catalog read/);
});

test("skills find is ruled out, with the reason", () => {
  assert.match(procedure, /Do not use `weldall skills find`/);
  assert.match(procedure, /snapshot/);
});

// A run with no request matches nothing, so without this section the no-match row fires and
// the person who ran the procedure to find out what Weldall does is told it cannot help.
test("a run with no request lists the catalog instead of reaching the outcome table", () => {
  const section = procedure.match(/## If there is no request yet\n([\s\S]*?)\n## /);
  assert.ok(section, "procedure.md must handle being run without a request");
  assert.match(section[1], /Run the\s+same lookup/);
  assert.match(section[1], /Do not pick a\s+skill and do not call anything/);
  assert.match(section[1], /asking what they want to do/);
  assert.ok(
    procedure.indexOf("## If there is no request yet") <
      procedure.indexOf("## Branch on the result"),
    "the no-request section must come before the outcome table the agent would otherwise fall into",
  );
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
  assert.match(procedure, /`weldall login`\.\s+Do not retry/);
});

test("the placeholder rule names a concrete placeholder", () => {
  assert.match(procedure, /placeholder/);
  assert.ok(procedure.includes("<contract-id>"));
});

test("the load step uses weldall skills show, with --json, never find", () => {
  const block = procedure.match(/## Load and follow the skill\n([\s\S]*?)\n## /);
  assert.ok(block, "procedure.md must have a Load and follow the skill section");
  assert.match(block[1], /```sh\nweldall skills show <slug> --json\n```/);
  assert.ok(!block[1].includes("skills find"), "the load step must not name skills find");
});

test("the load step names the document field carrying the skill's instructions", () => {
  const block = procedure.match(/## Load and follow the skill\n([\s\S]*?)\n## /);
  assert.match(block[1], /`document` field holds the instructions/);
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
