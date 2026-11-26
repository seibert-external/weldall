import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { formatAgentEntry, formatAgentWarning } from "../src/commands.js";
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
  createdAt: "2026-11-19T09:30:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2027-02-18T10:00:00.000Z",
  expired: false,
  source: { type: "resource", key: "registry", name: "Registry" },
};

const registry = {
  key: "registry",
  name: "Registry",
  endpoint: "https://registry.example.com/api/agents",
  scope: "registry:agents",
  allowed: true,
};
const shareableScope = { key: "intranet:user", description: "Use the intranet" };
const empty = { items: [], warnings: [], registries: [], shareableScopes: [] };

describe("agent list", () => {
  it("accepts what GET /api/me/agents serves", () => {
    const list = {
      items: [agent, { ...agent, own: true, ownerName: null }],
      warnings: [],
      registries: [registry],
      shareableScopes: [shareableScope],
    };
    expect(parseAgentList(list)).toEqual(list);
    expect(
      parseAgentList({
        ...empty,
        warnings: [{ source: "registry", code: "agents_skipped", count: 2 }],
      }).warnings,
    ).toHaveLength(1);
  });

  it.each([
    ["no object", []],
    ["no items", { ...empty, items: undefined }],
    ["an agent without a name", { ...empty, items: [{ ...agent, name: undefined }] }],
    ["an agent without a config", { ...empty, items: [{ ...agent, config: null }] }],
    ["a malformed warning", { ...empty, warnings: ["catalog_expired"] }],
    ["an agent without a revision", { ...empty, items: [{ ...agent, revision: "1" }] }],
    ["an agent without createdAt", { ...empty, items: [{ ...agent, createdAt: undefined }] }],
    ["a non-string createdAt", { ...empty, items: [{ ...agent, createdAt: 1 }] }],
    ["an agent without updatedAt", { ...empty, items: [{ ...agent, updatedAt: undefined }] }],
    ["an agent without expiresAt", { ...empty, items: [{ ...agent, expiresAt: null }] }],
    [
      "a source without a type",
      { ...empty, items: [{ ...agent, source: { key: "registry", name: "Registry" } }] },
    ],
    ["no registries", { ...empty, registries: undefined }],
    ["a registry without an endpoint", { ...empty, registries: [{ ...registry, endpoint: 1 }] }],
    ["a registry without allowed", { ...empty, registries: [{ ...registry, allowed: "yes" }] }],
    ["no shareable scopes", { ...empty, shareableScopes: undefined }],
    ["a shareable scope given as a string", { ...empty, shareableScopes: ["intranet:user"] }],
    [
      "a shareable scope without a description",
      { ...empty, shareableScopes: [{ key: "intranet:user" }] },
    ],
  ])("refuses %s", (_name, value) => {
    expect(() => parseAgentList(value)).toThrow("invalid agent list");
  });
});

describe("agent list request", () => {
  it("passes registries and shareable scopes through from the server", async () => {
    const body = {
      items: [agent],
      warnings: [],
      registries: [registry],
      shareableScopes: [shareableScope],
    };
    const fetch = serve(() => Response.json(body));

    await expect(listAgents(config)).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith(`${issuer}/api/me/agents`, expect.anything());
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
  it("shows owner, purpose, and the created and expiry dates", () => {
    expect(formatAgentEntry(agent)).toBe(
      [
        "registry.agt_1  ·  Intranet helper  ·  by Olivia Owner  ·  shared with intranet:user" +
          "  ·  created 2026-11-19 09:30 UTC  ·  expires 2027-02-18 10:00 UTC",
        "  Answers questions about the intranet",
      ].join("\n"),
    );
  });

  it("marks own and expired agents and leaves out an empty purpose", () => {
    const line = formatAgentEntry({
      ...agent,
      own: true,
      ownerName: null,
      description: "",
      expired: true,
    });
    expect(line).toBe(
      "registry.agt_1  ·  Intranet helper  ·  yours  ·  shared with intranet:user" +
        "  ·  created 2026-11-19 09:30 UTC  ·  expired 2027-02-18 10:00 UTC",
    );
  });

  it("neutralizes control characters in everything the server sent", () => {
    const esc = "\u001b";
    const bel = "\u0007";
    const output = formatAgentEntry({
      ...agent,
      id: `registry.agt_1${esc}[2J`,
      name: `Helper${esc}]8;;https://attacker.example.com${bel}click${esc}]8;;${bel}`,
      ownerName: `Olivia${esc}[31m Owner`,
      scopes: [`intranet:user${"\u009b"}0m`, `x${"\u0000"}y`],
      createdAt: `not a date${esc}[H`,
      description: `Line one\nline two\t${esc}]52;c;cGF5bG9hZA==${bel}${esc}[1;31mred${"\u007f"}`,
    });

    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(output).toBe(
      [
        "registry.agt_1\uFFFD[2J  ·  Helper\uFFFD]8;;https://attacker.example.com\uFFFDclick\uFFFD]8;;\uFFFD" +
          "  ·  by Olivia\uFFFD[31m Owner  ·  shared with intranet:user\uFFFD0m, x\uFFFDy" +
          "  ·  created not a date\uFFFD[H  ·  expires 2027-02-18 10:00 UTC",
        "  Line one line two \uFFFD]52;c;cGF5bG9hZA==\uFFFD\uFFFD[1;31mred\uFFFD",
      ].join("\n"),
    );
  });

  it("neutralizes control characters in warnings", () => {
    expect(
      formatAgentWarning({ source: "registry\u001b[2J", code: "catalog_expired\u001b]0;x\u0007" }),
    ).toBe("Agents from registry\uFFFD[2J: catalog_expired\uFFFD]0;x\uFFFD");
  });
});
