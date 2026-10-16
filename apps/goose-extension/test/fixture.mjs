import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const organizationInstructions =
  "Example Group's internal business data is available through Weldall.\nBefore answering business questions, run weldall skills list --agentic and read every returned item. Use internal sources before public estimates.";

export async function fixture() {
  const root = await mkdtemp(fileURLToPath(new URL("../../../.goose-test-", import.meta.url)));
  const bin = path.join(root, "local-bin");
  const cwd = path.join(root, "unrelated");
  await mkdir(bin);
  await mkdir(cwd);
  const executable = path.join(bin, "weldall");
  await writeFile(
    executable,
    `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(process.env.FAKE_VERSION ?? "0.20.0"); process.exit(); }
if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "status") {
  if (process.env.FAKE_STATUS_ERROR) { console.error("Organization context unavailable"); process.exit(3); }
  console.log(process.env.FAKE_STATUS ?? JSON.stringify({organizationInstructions: ${JSON.stringify(organizationInstructions)}, identity: {email: "should-not-escape"}, grants: ["should-not-escape"]}));
  process.exit();
}
if (process.env.FAKE_PID) fs.writeFileSync(process.env.FAKE_PID, String(process.pid));
if (process.env.FAKE_WAIT) { setInterval(() => {}, 1000); }
else if (process.env.FAKE_ERROR) { console.error("\\x1b[31mMissing scope: expenses:read\\x1b[0m\\nAsk for access, then run weldall login."); process.exit(3); }
else if (process.env.FAKE_LARGE) { process.stdout.write("x".repeat(3 * 1024 * 1024)); }
else {
  const skill = {slug: "expenses.review", title: "Review expenses", preview: "Review employee expenses", available: true, missingScopes: [], source: {type: "admin"}, meta: {tags: ["expense"]}};
  if (args[0] === "skills" && args[1] === "show") console.log(JSON.stringify({...skill, slug: args[2], document: "# Expenses\\nRead the expense API.", ...(args[2] === "mcp.review" ? {mcpDependencies: [{connectorKey: "google", tools: ["fixture.read"], includeResources: true}]} : {}), privateKey: "should-not-escape"}));
  else if (args[0] === "skills" && args[1] === "find") console.log(JSON.stringify([{slug: skill.slug, title: skill.title, preview: skill.preview, available: skill.available, tags: skill.meta.tags, sourceName: "Weldall"}]));
  else if (args[0] === "skills") console.log(JSON.stringify({items: [skill], warnings: []}));
  else if (args[0] === "connections") console.log(JSON.stringify([{id: "connection-1", name: "work", connectorKey: "google", capabilities: ["mcp"], connectorEnabled: true, status: "READY", accountName: "Test account", selectedScopes: ["mail:read", "mail:send"], grantedScopes: ["mail:read"], details: [{label: "Workspace", value: "example.com", providerToken: "should-not-escape"}], providerToken: "should-not-escape"}]));
  else if (args[0] === "mcp") {
    const uri = "fixture:///report";
    const results = {
      list: [{key: "google", name: "Fixture MCP", capabilities: ["mcp"]}],
      tools: {tools: [{name: "fixture.read", inputSchema: {type: "object"}}]},
      resources: {resources: [{uri, name: "Report"}]},
      call: {content: [{type: "resource_link", uri, name: "Report"}], structuredContent: {complete: true}},
      "read-resource": {contents: [{uri, text: "Packed fixture result"}]}
    };
    console.log(JSON.stringify(results[args[1]]));
  }
  else console.log(JSON.stringify({ok: true, method: args.find((arg) => arg.startsWith("--method="))}));
}
`,
    { mode: 0o755 },
  );
  // Extension-less ESM scripts inherit the nearest package.json.
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  return {
    root,
    bin,
    cwd,
    executable,
    env,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
