import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { formatAgentEntry } from "../src/commands.js";
import { listAgents, parseAgentList } from "../src/services/agents.js";

const state = vi.hoisted(() => ({ session: null as any }));
vi.mock("../src/services/auth.js", () => ({
  withAccess: async (_config: unknown, operation: (session: unknown) => Promise<unknown>) =>
    operation(state.session),
}));

const issuer = "https://weldall.example.com";
const config: WeldallConfig = {
  issuer,
  resource: `${issuer}/api`,
  authorize: `${issuer}/api/auth/oauth2/authorize`,
  token: `${issuer}/api/auth/oauth2/token`,
  revoke: `${issuer}/api/auth/oauth2/revoke`,
  jwks: `${issuer}/api/oauth/jwks`,
  cli: `${issuer}/api/me/cli`,
  grants: `${issuer}/api/me/grants`,
  scopes: `${issuer}/api/me/scopes`,
  skills: `${issuer}/api/me/skills`,
  userInfo: `${issuer}/api/auth/oauth2/userinfo`,
};

beforeEach(async () => {
  const key = await generateEs256KeyPair();
  state.session = {
    accessToken: "access-a",
    subject: "account-a",
    credentials: {
      version: 2,
      issuer,
      ...key,
      refreshToken: "refresh-a",
      accessSession: {
        accessToken: "access-a",
        subject: "account-a",
        expiresAt: Math.floor(Date.now() / 1_000) + 600,
      },
    },
  };
  vi.unstubAllGlobals();
});

const serve = (response: () => Response) => {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

const agent = {
  id: "registry.agt_1",
  sourceId: "agt_1",
  name: "Intranet helper",
  description: "Answers questions about the intranet",
  own: false,
  ownerName: "Olivia Owner",
  scopes: ["intranet:user"],
  config: { format: "weldall-agent", version: 1, definition: { instructions: "Help." } },
  revision: 1,
  updatedAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2027-02-18T10:00:00.000Z",
  expired: false,
  source: { type: "resource", key: "registry", name: "Registry" },
};

describe("agent list", () => {
  it("accepts what GET /api/me/agents serves", () => {
    const list = { items: [agent, { ...agent, own: true, ownerName: null }], warnings: [] };
    expect(parseAgentList(list)).toEqual(list);
    expect(
      parseAgentList({ items: [], warnings: [{ source: "registry", code: "catalog_expired" }] })
        .warnings,
    ).toHaveLength(1);
  });

  it.each([
    ["no object", []],
    ["no items", { warnings: [] }],
    ["an agent without a name", { items: [{ ...agent, name: undefined }], warnings: [] }],
    ["an agent without a config", { items: [{ ...agent, config: null }], warnings: [] }],
    ["a malformed warning", { items: [], warnings: ["catalog_expired"] }],
    ["an agent without a revision", { items: [{ ...agent, revision: "1" }], warnings: [] }],
    ["an agent without updatedAt", { items: [{ ...agent, updatedAt: undefined }], warnings: [] }],
    ["an agent without expiresAt", { items: [{ ...agent, expiresAt: null }], warnings: [] }],
    ["a non-string createdAt", { items: [{ ...agent, createdAt: 1 }], warnings: [] }],
    [
      "a source without a type",
      { items: [{ ...agent, source: { key: "registry", name: "Registry" } }], warnings: [] },
    ],
  ])("refuses %s", (_name, value) => {
    expect(() => parseAgentList(value)).toThrow("invalid agent list");
  });
});

describe("agent list request", () => {
  it("passes registries and shareable scopes through from a current server", async () => {
    const body = {
      items: [{ ...agent, createdAt: "2026-11-19T09:30:00.000Z" }],
      warnings: [],
      registries: [{ key: "registry", url: "https://registry.example.com" }],
      shareableScopes: ["intranet:user"],
    };
    const fetch = serve(() => Response.json(body));

    await expect(listAgents(config)).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith(`${issuer}/api/me/agents`, expect.anything());
  });

  it("accepts a server from before createdAt, registries and shareable scopes", async () => {
    serve(() => Response.json({ items: [agent], warnings: [] }));

    const list = await listAgents(config);
    expect(list).toEqual({ items: [agent], warnings: [] });
    expect(list.registries).toBeUndefined();
    expect(list.shareableScopes).toBeUndefined();
    expect(list.items[0]?.createdAt).toBeUndefined();
  });

  it.each([
    ["an empty 404", () => new Response(null, { status: 404 })],
    ["a 404 page", () => new Response("<html>Not found</html>", { status: 404 })],
    ["a JSON 404", () => Response.json({ error: "not_found" }, { status: 404 })],
  ])("reports a server without agent discovery that answers %s", async (_name, response) => {
    serve(response);

    const failure = listAgents(config);
    await expect(failure).rejects.toThrow("This Weldall server does not offer shared agents.");
    await expect(failure).rejects.toMatchObject({
      hint: "Agent discovery needs a newer Weldall server.",
    });
  });

  it("names the agent list, not the skill registry, when another request fails", async () => {
    serve(() => Response.json({ error: "HTTP 404 upstream" }, { status: 500 }));

    const failure = listAgents(config);
    await expect(failure).rejects.toThrow(/^Weldall agent list request failed with HTTP 500/);
    await expect(failure).rejects.not.toThrow("does not offer shared agents");
  });
});

describe("agent list output", () => {
  it("shows owner, purpose, and the expiry date", () => {
    expect(formatAgentEntry(agent)).toBe(
      [
        "registry.agt_1  ·  Intranet helper  ·  by Olivia Owner  ·  shared with intranet:user" +
          "  ·  expires 2027-02-18 10:00 UTC",
        "  Answers questions about the intranet",
      ].join("\n"),
    );
  });

  it("shows the created date when the server sends one and marks expired agents", () => {
    const line = formatAgentEntry({
      ...agent,
      own: true,
      ownerName: null,
      description: "",
      createdAt: "2026-11-19T09:30:00.000Z",
      expired: true,
    });
    expect(line).toBe(
      "registry.agt_1  ·  Intranet helper  ·  yours  ·  shared with intranet:user" +
        "  ·  created 2026-11-19 09:30 UTC  ·  expired 2027-02-18 10:00 UTC",
    );
  });
});
