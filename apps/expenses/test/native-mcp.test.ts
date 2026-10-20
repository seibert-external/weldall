import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  JWT_DPOP_GRANT,
  MACHINE_TOKEN_TYP,
  SKILL_ASSERTION_TYPE,
  createDpopProof,
  generateEs256KeyPair,
  issueIdJag,
  parseSkillCatalog,
  signEs256,
  type DpopKeyPair,
} from "@weldall/sdk";
import { createApp } from "../src/app.js";
import {
  DOWNSTREAM_CLIENT_ID,
  EXPENSES_ISSUER,
  EXPENSES_RESOURCE,
  EXPENSES_TOKEN_ENDPOINT,
  WELDALL_ISSUER,
} from "../src/constants.js";

const endpoint = `${EXPENSES_ISSUER}/api/mcp`;
let app: Awaited<ReturnType<typeof createApp>>;
let issuerKey: DpopKeyPair;
let deviceKey: DpopKeyPair;

beforeEach(async () => {
  const resourceKey = await generateEs256KeyPair();
  issuerKey = await generateEs256KeyPair();
  deviceKey = await generateEs256KeyPair();
  vi.stubEnv("EXPENSES_SIGNING_PRIVATE_JWK", JSON.stringify(resourceKey.privateJwk));
  vi.stubEnv("EXPENSES_SIGNING_PUBLIC_JWK", JSON.stringify(resourceKey.publicJwk));
  vi.stubEnv("EXPENSES_SIGNING_KID", "expenses-test");
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${WELDALL_ISSUER}/.well-known/oauth-authorization-server`)
      return Response.json({ issuer: WELDALL_ISSUER, jwks_uri: `${WELDALL_ISSUER}/jwks` });
    if (url === `${WELDALL_ISSUER}/jwks`)
      return Response.json({
        keys: [{ ...issuerKey.publicJwk, kid: "issuer-test", alg: "ES256", use: "sig" }],
      });
    throw new Error(`Unexpected network request: ${url}`);
  });
  app = await createApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function tokenFor(identity: "user" | "machine", scopes: string[]) {
  if (identity === "machine") {
    const now = Math.floor(Date.now() / 1000);
    return signEs256(
      {
        iss: WELDALL_ISSUER,
        sub: "machine:dev-expenses-reader",
        client_id: "dev-expenses-reader",
        azp: "dev-expenses-reader",
        aud: EXPENSES_RESOURCE,
        scope: scopes.join(" "),
        identity_type: "machine",
        token_type: "machine",
        cnf: { jkt: deviceKey.jkt },
        iat: now,
        exp: now + 300,
        jti: crypto.randomUUID(),
      },
      { kid: "issuer-test", privateJwk: issuerKey.privateJwk, typ: MACHINE_TOKEN_TYP },
    );
  }
  const assertion = await issueIdJag({
    issuer: WELDALL_ISSUER,
    subject: "alice",
    email: "alice@example.com",
    audience: EXPENSES_ISSUER,
    clientId: DOWNSTREAM_CLIENT_ID,
    resource: EXPENSES_RESOURCE,
    scopes,
    jkt: deviceKey.jkt,
    kid: "issuer-test",
    privateJwk: issuerKey.privateJwk,
  });
  const response = await app.request(EXPENSES_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      dpop: await createDpopProof({ ...deviceKey, method: "POST", url: EXPENSES_TOKEN_ENDPOINT }),
    },
    body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function request(token: string, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `DPoP ${token}`);
  headers.set(
    "dpop",
    await createDpopProof({ ...deviceKey, method: init.method ?? "GET", url, accessToken: token }),
  );
  return app.request(url, { ...init, headers });
}

async function withClient(token: string, run: (client: Client) => Promise<void>) {
  const client = new Client({ name: "expenses-demo-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: async (url, init) => {
      expect(String(url)).toBe(endpoint);
      return request(token, String(url), init);
    },
  });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
  }
}

const rpc = (method: string, params: Record<string, unknown> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

describe("Expenses Task 1 demo", () => {
  it("previews approve/deny through authenticated tools without changing expenses", async () => {
    const token = await tokenFor("user", ["expenses:read"]);
    await withClient(token, async (client) => {
      const view = (await client.listResources()).resources.find(
        (r) => r.uri === "ui://weldall/expenses",
      )!;
      expect(view._meta).toMatchObject({ ui: { allowedTools: ["preview_expense_decision"] } });
      const before = await client.callTool({ name: "list_expenses" });
      for (const decision of ["approve", "deny"]) {
        expect(
          await client.callTool({
            name: "preview_expense_decision",
            arguments: { expenseId: "expense-1", decision },
          }),
        ).toMatchObject({
          structuredContent: {
            expenseId: "expense-1",
            decision,
            simulated: true,
            persisted: false,
          },
        });
      }
      expect(await client.callTool({ name: "list_expenses" })).toEqual(before);
      await expect(
        client.callTool({
          name: "preview_expense_decision",
          arguments: { expenseId: "someone-elses-expense", decision: "approve" },
        }),
      ).rejects.toMatchObject({ code: -32602 });
    });
    for (const path of ["/mcp-ui/expenses.js", "/mcp-ui/sdk.js"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/javascript");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.text()).toContain("callMcpAppTool");
    }
  });

  it("starts when a deployment exposes only its configured read scope", async () => {
    vi.stubEnv("DOWNSTREAM_SCOPES", "expenses:read");
    const readOnlyApp = await createApp();

    const metadata = await readOnlyApp.request("/.well-known/oauth-protected-resource");
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).weldall_mcp).toMatchObject({
      discoveryScopes: ["expenses:read"],
    });
  });

  it("advertises the native endpoint, discovery scope and stable revision alongside HTTP", async () => {
    const metadata = await app.request("/.well-known/oauth-protected-resource");
    expect(metadata.status).toBe(200);
    const document = await metadata.json();
    expect(document).toMatchObject({
      resource: EXPENSES_RESOURCE,
      weldall_mcp: {
        endpoint,
        discoveryScopes: ["expenses:read"],
        transport: "streamable-http-stateless",
        capabilities: ["tools", "resources"],
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const repeat = await app.request("/.well-known/oauth-protected-resource");
    expect(await repeat.json()).toEqual(document);
  });

  it("publishes the whole-resource dependency through the authenticated skill catalog", async () => {
    const url = `${EXPENSES_ISSUER}/.well-known/weldall-skills`;
    expect((await app.request(url)).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signEs256(
      {
        iss: WELDALL_ISSUER,
        sub: WELDALL_ISSUER,
        aud: url,
        resource: EXPENSES_RESOURCE,
        purpose: "skills:read",
        iat: now,
        exp: now + 60,
        jti: crypto.randomUUID(),
      },
      { kid: "issuer-test", privateJwk: issuerKey.privateJwk, typ: SKILL_ASSERTION_TYPE },
    );
    const response = await app.request(url, { headers: { authorization: `Bearer ${assertion}` } });
    expect(response.status).toBe(200);
    const catalog = parseSkillCatalog(await response.json(), EXPENSES_RESOURCE);
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]).toMatchObject({
      id: "review",
      requiredScopes: ["expenses:read"],
      mcpDependencies: [{ kind: "resource", resourceKey: "expenses" }],
      content: expect.stringContaining("list_expenses"),
    });
  });

  it.each(["user", "machine"] as const)(
    "serves identical HTTP/tool/resource data for a %s and denies writes with a read-only token",
    async (identity) => {
      const token = await tokenFor(identity, ["expenses:read"]);
      const response = await request(token, `${EXPENSES_RESOURCE}/expenses`);
      expect(response.status).toBe(200);
      const http = await response.json();
      expect(http.identityType).toBe(identity);
      await withClient(token, async (client) => {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          "create_expense",
          "list_expenses",
          "preview_expense_decision",
        ]);
        expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([
          "ui://weldall/expenses",
          "expenses://current",
        ]);
        expect(await client.callTool({ name: "list_expenses", arguments: {} })).toMatchObject({
          structuredContent: http,
          content: [{ type: "text", text: JSON.stringify(http) }],
        });
        const resource = await client.readResource({ uri: "expenses://current" });
        expect(JSON.parse(String(resource.contents[0]?.text))).toEqual(http);
        await expect(
          client.callTool({ name: "create_expense", arguments: { description: "Demo lunch" } }),
        ).rejects.toMatchObject({ code: -32003 });
      });
    },
  );

  it.each(["user", "machine"] as const)(
    "links the tool to an authenticated HTML view for a %s, with public display assets",
    async (identity) => {
      const token = await tokenFor(identity, ["expenses:read"]);
      await withClient(token, async (client) => {
        const tool = (await client.listTools()).tools.find(
          (item) => item.name === "list_expenses",
        )!;
        expect(tool._meta?.ui).toEqual({
          resourceUri: "ui://weldall/expenses",
          visibility: ["model"],
        });
        const result = await client.readResource({ uri: "ui://weldall/expenses" });
        expect(result.contents[0]).toMatchObject({
          mimeType: "text/html;profile=mcp-app",
          _meta: { ui: { csp: { resourceDomains: [EXPENSES_ISSUER] } } },
        });
        const html = String(result.contents[0]!.text);
        expect(html).toContain("Team lunch");
        expect(html).toContain("18.50 EUR");
        expect(html).toContain(identity === "user" ? "alice@example.com" : "dev-expenses-reader");
        expect(html).toContain(`${EXPENSES_ISSUER}/mcp-ui/expenses.css`);
        expect(html).toContain('"displayModes":["inline","fullscreen","pip"]');
        expect(html).toContain("ui/notifications/size-changed");
        expect(html).toContain("script-src &#39;sha256-");
        expect(html).not.toContain("<form");
      });
      expect(
        (await app.request(endpoint, rpc("resources/read", { uri: "ui://weldall/expenses" })))
          .status,
      ).toBe(401);
      const denied = await tokenFor(identity, ["expenses:create"]);
      expect(
        (await request(denied, endpoint, rpc("resources/read", { uri: "ui://weldall/expenses" })))
          .status,
      ).toBe(403);
      const css = await app.request("/mcp-ui/expenses.css");
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      expect(await css.text()).toContain(".expenses");
    },
  );

  it("allows a valid demonstration write only with its scope and does not persist it", async () => {
    const token = await tokenFor("user", ["expenses:read", "expenses:create"]);
    await withClient(token, async (client) => {
      await expect(
        client.callTool({ name: "create_expense", arguments: { description: "" } }),
      ).rejects.toMatchObject({ code: -32602 });
      const created = await client.callTool({
        name: "create_expense",
        arguments: { description: "Demo lunch" },
      });
      expect(created).toMatchObject({
        content: [
          { type: "text", text: JSON.stringify({ id: "expense-new", description: "Demo lunch" }) },
        ],
      });
    });
    const after = await request(token, `${EXPENSES_RESOURCE}/expenses`);
    expect((await after.json()).expenses).toEqual([
      { id: "expense-1", description: "Team lunch", amount: 18.5, currency: "EUR" },
    ]);
  });

  it.each(["initialize", "tools/list", "resources/list", "resources/read"])(
    "denies anonymous %s",
    async (method) => {
      expect((await app.request(endpoint, rpc(method, { uri: "expenses://current" }))).status).toBe(
        401,
      );
    },
  );

  it.each(["user", "machine"] as const)(
    "requires the discovery scope for a %s",
    async (identity) => {
      const token = await tokenFor(identity, ["expenses:create"]);
      expect((await request(token, endpoint, rpc("tools/list"))).status).toBe(403);
    },
  );

  it("rejects replayed native DPoP proofs", async () => {
    const token = await tokenFor("user", ["expenses:read"]);
    const init = rpc("tools/list");
    const headers = {
      ...init.headers,
      authorization: `DPoP ${token}`,
      dpop: await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: endpoint,
        accessToken: token,
      }),
    };
    expect((await app.request(endpoint, { ...init, headers })).status).toBe(200);
    expect((await app.request(endpoint, { ...init, headers })).status).toBe(401);
  });
});
