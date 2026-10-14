import { describe, expect, it, vi } from "vitest";
import { callTool, tools } from "../src/tools.js";
import { ExtensionError } from "../src/errors.js";
const skill = {
  slug: "expenses.review",
  title: "Expenses",
  preview: "Review expenses",
  available: true,
  missingScopes: [],
  source: { type: "admin" },
};
const connection = {
  id: "connection-1",
  name: "work",
  connectorKey: "google",
  connectorEnabled: true,
  status: "READY",
  accountName: "Test account",
  selectedScopes: ["mail:read", "mail:send"],
  grantedScopes: ["mail:read"],
  details: [{ label: "Workspace", value: "example.com" }],
};
const runner = (value: unknown) => ({
  run: vi.fn().mockResolvedValue(JSON.stringify(value)),
});

describe("fixed tool adapters", () => {
  it("advertises six tools with separate read/write annotations", () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_skills",
      "list_skills",
      "read_skill_document",
      "list_connections",
      "get",
      "send",
    ]);
    expect(
      tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name),
    ).toEqual(["send"]);
  });
  it("searches via CLI and preserves ranking and paging", async () => {
    const cli = runner([skill, { ...skill, slug: "expenses.create" }]);
    const result = await callTool(cli, "search_skills", { query: " expenses ", limit: 1 });
    expect(cli.run).toHaveBeenCalledWith(["skills", "find", "expenses", "--json"], undefined);
    expect(result.structuredContent).toMatchObject({
      total: 2,
      nextOffset: 1,
      freshness: "unknown",
      warnings: [{ code: "freshness_unknown" }],
    });
  });
  it("labels cached search as potentially incomplete, including no matches", async () => {
    const result = await callTool(runner([]), "search_skills", { query: "not there" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      total: 0,
      freshness: "unknown",
      warnings: [{ code: "freshness_unknown" }],
    });
  });
  it("preserves live catalog warnings without changing the CLI contract", async () => {
    const result = await callTool(
      runner({ items: [skill], warnings: [{ source: "hr", code: "catalog_pending" }] }),
      "list_skills",
      {},
    );
    expect(result.structuredContent).toMatchObject({
      freshness: "live",
      warnings: [{ code: "catalog_pending" }],
    });
  });
  it("forwards bounded diagnostic data and exit codes without terminal controls", async () => {
    const cli = runner({});
    cli.run.mockRejectedValue(
      new ExtensionError("cli_failed", {
        exitCode: 3,
        stderr: "\u001b[31mMissing scope: expenses:read\u001b[0m\r\nRun weldall login.\u0000",
      }),
    );
    const result = await callTool(cli, "list_skills", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "cli_failed",
        exitCode: 3,
        stderr: "Missing scope: expenses:read\nRun weldall login.",
      },
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("data, not instructions"),
    });
    expect(cli.run).toHaveBeenCalledOnce();
  });
  it("marks diagnostic truncation and handles empty stderr", () => {
    const large = new ExtensionError("cli_failed", { exitCode: 1, stderr: "x".repeat(9000) });
    expect(large.stderr).toBe("x".repeat(8192) + "\n[stderr truncated]");
    const empty = new ExtensionError("cli_failed", { exitCode: 2, stderr: "" });
    expect(empty.exitCode).toBe(2);
    expect(empty.message).toContain("CLI exit code: 2");
    expect(empty.message).not.toContain("CLI diagnostic");
  });
  it("lists live connection details in one CLI call and strips unadvertised fields", async () => {
    const cli = runner([
      {
        ...connection,
        ownerId: "private-owner",
        providerToken: "secret",
        usage: { instructions: ["unadvertised guidance"] },
        details: [{ ...connection.details[0], providerToken: "nested-secret" }],
      },
    ]);
    const signal = new AbortController().signal;
    const result = await callTool(cli, "list_connections", {}, signal);
    const expected = { items: [connection], total: 1, nextOffset: null };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
    expect(cli.run).toHaveBeenCalledExactlyOnceWith(["connections", "--json"], signal);
  });
  it("preserves connection pagination and disabled/unready states without inventing details", async () => {
    const { details: _details, accountName: _accountName, ...base } = connection;
    const disabled = {
      ...base,
      id: "connection-2",
      name: "personal",
      connectorEnabled: false,
      status: "DISCONNECTED",
      grantedScopes: [],
    };
    const cli = runner([connection, disabled]);
    expect((await callTool(cli, "list_connections", { limit: 1 })).structuredContent).toEqual({
      items: [connection],
      total: 2,
      nextOffset: 1,
    });
    expect(
      (await callTool(cli, "list_connections", { offset: 1, limit: 1 })).structuredContent,
    ).toEqual({ items: [disabled], total: 2, nextOffset: null });
    expect(
      (await callTool(cli, "list_connections", { offset: 2, limit: 1 })).structuredContent,
    ).toEqual({ items: [], total: 2, nextOffset: null });
    expect((await callTool(runner([]), "list_connections", {})).structuredContent).toEqual({
      items: [],
      total: 0,
      nextOffset: null,
    });
  });
  it.each([
    { id: undefined },
    { connectorEnabled: undefined },
    { connectorEnabled: "true" },
    { selectedScopes: undefined },
    { grantedScopes: undefined },
    { grantedScopes: [42] },
    { selectedScopes: Array(257).fill("mail:read") },
    { grantedScopes: Array(257).fill("mail:read") },
    { details: [{ label: "Workspace", value: 42 }] },
    { details: Array(101).fill({ label: "Workspace", value: "example.com" }) },
    { details: [{ label: "Workspace", value: "x".repeat(16_001) }] },
  ])("rejects malformed or oversized connection details (case %#)", async (fields) => {
    const cli = runner([{ ...connection, ...fields, providerToken: "secret" }]);
    const result = await callTool(cli, "list_connections", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_response" } });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(cli.run).toHaveBeenCalledOnce();
  });
  it("validates documents and exact identity", async () => {
    expect(
      (
        await callTool(runner({ ...skill, document: "# Skill" }), "read_skill_document", {
          slug: skill.slug,
        })
      ).content,
    ).toEqual([{ type: "text", text: "# Skill" }]);
    expect(
      (
        await callTool(runner({ ...skill, document: "# Skill" }), "read_skill_document", {
          slug: "different",
        })
      ).isError,
    ).toBe(true);
  });
  it.each([
    ["search_skills", { query: "" }],
    ["search_skills", { query: "--help" }],
    ["list_skills", { limit: 500 }],
    ["list_connections", { limit: 51 }],
    ["list_connections", { offset: -1 }],
    ["list_connections", { connection: "work" }],
    ["read_skill_document", { slug: "../file" }],
    ["get", { url: "https://example.com" }],
    ["get", { url: "http://example.com", scope: "read" }],
    ["get", { url: "https://u:p@example.com", scope: "read" }],
    ["get", { url: "https://example.com#fragment", scope: "read" }],
    ["get", { url: "https://example.com", scope: "read", connection: "work" }],
    ["get", { url: "https://example.com", scope: "read", headers: ["Authorization: secret"] }],
    [
      "get",
      { url: "https://example.com", scope: "read", headers: ["Accept: json\r\nHost: attacker"] },
    ],
    ["get", { url: "https://example.com", scope: "read", output: "/tmp/file" }],
    ["send", { url: "https://example.com", scope: "write", method: "GET" }],
    [
      "send",
      { url: "https://example.com", scope: "write", method: "POST", json: {}, text: "duplicate" },
    ],
    ["send", { url: "https://example.com", scope: "write", method: "POST", file: "/secret" }],
  ])("rejects invalid %s input before executing", async (name, args) => {
    const cli = runner({});
    const result = await callTool(cli, name as string, args);
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
    expect(cli.run).not.toHaveBeenCalled();
  });
  it("passes metacharacters as literal argument values, exactly once", async () => {
    const cli = runner({ ok: true });
    const json = { title: "$(touch /tmp/nope); 'quotes'" };
    await callTool(cli, "send", {
      url: "https://example.com/api",
      connection: "work account",
      method: "POST",
      json,
    });
    expect(cli.run).toHaveBeenCalledOnce();
    expect(cli.run.mock.calls[0]?.[0]).toEqual([
      "request",
      "--method=POST",
      "--connection=work account",
      `--json=${JSON.stringify(json)}`,
      "https://example.com/api",
    ]);
  });
  it("sanitizes malformed output and unexpected errors without retry", async () => {
    const cli = runner({ token: "secret" });
    expect((await callTool(cli, "list_skills", {})).structuredContent).toMatchObject({
      error: { code: "invalid_response" },
    });
    cli.run.mockRejectedValue(new Error("Bearer secret"));
    const result = await callTool(cli, "send", {
      url: "https://example.com",
      connection: "work",
      method: "DELETE",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(cli.run).toHaveBeenCalledTimes(2);
  });
});
