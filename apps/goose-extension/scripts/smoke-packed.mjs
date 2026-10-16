import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fixture, organizationInstructions } from "../test/fixture.mjs";
if (process.platform === "win32")
  throw new Error("Packed fake-CLI smoke requires POSIX; Windows needs the local native .exe.");
const root = fileURLToPath(new URL("../", import.meta.url));
const f = await fixture();
const client = new Client({ name: "packed-smoke", version: "1" });
let toolChanges = 0,
  resourceChanges = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
  toolChanges++;
});
client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
  resourceChanges++;
});
try {
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", f.root], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      f.cwd,
      path.join(f.root, packed.filename),
    ],
    { cwd: f.cwd, stdio: "pipe" },
  );
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["--no-install", "weldall-goose"],
    cwd: f.cwd,
    env: f.env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await client.connect(transport);
  assert.ok(client.getInstructions()?.includes(organizationInstructions));
  assert.ok(!client.getInstructions()?.includes("should-not-escape"));
  assert.ok(client.getInstructions()?.includes("CLI-to-MCP mapping:"));
  assert.ok(client.getInstructions()?.includes("do not silently drop options"));
  const advertised = (await client.listTools()).tools;
  assert.equal(advertised.length, 6);
  for (const name of ["get", "send"]) {
    assert.ok(
      advertised.find((tool) => tool.name === name)?.description?.includes("Use instead of shell"),
    );
  }
  for (const tool of advertised) {
    assert.ok(
      !JSON.stringify(tool.inputSchema).includes('"$ref"'),
      `${tool.name}: Code Mode schemas must not contain references`,
    );
    assert.ok(
      !JSON.stringify(tool.inputSchema).includes('"$defs"'),
      `${tool.name}: Code Mode schemas must not contain definitions`,
    );
  }
  for (const [name, args] of [
    ["search_skills", { query: "expense" }],
    ["list_skills", {}],
    ["read_skill_document", { slug: "expenses.review" }],
    ["list_connections", {}],
    ["get", { url: "https://example.com/api", scope: "expenses:read" }],
    [
      "send",
      { url: "https://example.com/api", connection: "work", method: "POST", json: { amount: 24 } },
    ],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, name);
    assert.ok(!JSON.stringify(result).includes("should-not-escape"));
    if (name === "list_connections") {
      assert.deepEqual(result.structuredContent, {
        items: [
          {
            id: "connection-1",
            name: "work",
            connectorKey: "google",
            capabilities: ["mcp"],
            connectorEnabled: true,
            status: "READY",
            accountName: "Test account",
            selectedScopes: ["mail:read", "mail:send"],
            grantedScopes: ["mail:read"],
            details: [{ label: "Workspace", value: "example.com" }],
          },
        ],
        total: 1,
        nextOffset: null,
      });
    }
  }
  const loaded = await client.callTool({
    name: "read_skill_document",
    arguments: { slug: "mcp.review" },
  });
  assert.notEqual(loaded.isError, true);
  assert.equal(toolChanges, 1);
  assert.equal(resourceChanges, 1);
  const activated = (await client.listTools()).tools;
  assert.equal(activated.length, 7);
  const tool = activated.find((tool) => tool.name.endsWith("__fixture.read"));
  assert.ok(tool);
  const called = await client.callTool({ name: tool.name, arguments: {} });
  assert.deepEqual(called.structuredContent, { complete: true });
  const listed = await client.listResources();
  assert.ok(listed.resources[0].uri.startsWith("weldall-mcp://google/"));
  const read = await client.readResource({ uri: listed.resources[0].uri });
  assert.equal(read.contents[0].text, "Packed fixture result");
  assert.equal(stderr, "");
  console.log(
    "Installed tarball + npx + stdio: six stable tools, dynamic activation, list-change notifications, tool call and resource read passed (fake CLI; not Stock Goose acceptance).",
  );
} finally {
  await client.close();
  await f.cleanup();
}
