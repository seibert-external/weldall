import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDpopProof } from "../../src/index.js";
import { nativeMcpToolsSchema, parseMcpResponse } from "../../src/mcp/index.js";

const input = JSON.parse(readFileSync(0, "utf8"));
const client = new Client({ name: "python-interop-test", version: "1" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(input.localEndpoint), {
  fetch: async (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `DPoP ${input.token}`);
    headers.set(
      "dpop",
      await createDpopProof({
        privateJwk: input.device.private_jwk,
        publicJwk: input.device.public_jwk,
        jkt: input.device.jkt,
        url: input.publicEndpoint,
        method: init.method ?? "GET",
        accessToken: input.token,
      }),
    );
    return fetch(url, { ...init, headers });
  },
});
try {
  await client.connect(transport);
  const catalog = parseMcpResponse(nativeMcpToolsSchema, await client.listTools());
  assert.deepEqual(
    catalog.tools.map((t) => t.name),
    ["read", "write"],
  );
  assert.equal((await client.listResources()).resources[0]?.uri, "expenses://current");
  assert.deepEqual(
    (await client.callTool({ name: "write", arguments: { title: "New" } })).content,
    [{ type: "text", text: "user-1" }],
  );
  assert.deepEqual((await client.readResource({ uri: "expenses://current" })).contents, [
    { uri: "expenses://current", text: "user-1" },
  ]);
  console.log(JSON.stringify({ ok: true }));
} finally {
  await client.close();
}
