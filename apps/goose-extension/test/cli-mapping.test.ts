import { describe, expect, it, vi } from "vitest";
import { callTool } from "../src/tools.js";
import { REQUEST_TIMEOUT } from "../src/cli.js";

// Deterministic contract tests for documented, hand-mapped CLI equivalents.
// These do not simulate an LLM or prove that Goose chooses MCP instead of shell.
describe("CLI-to-MCP guidance", () => {
  it("returns CLI-based skill documents unchanged", async () => {
    const document =
      "# Read an expense\n\n```sh\nweldall request --scope expenses:read 'https://expenses.example/api/expenses?id=1'\n```\n";
    const cli = {
      run: vi.fn().mockResolvedValue(
        JSON.stringify({
          slug: "expenses.read",
          title: "Read an expense",
          preview: "Read",
          available: true,
          missingScopes: [],
          source: { type: "admin" },
          document,
        }),
      ),
    };
    const result = await callTool(cli, "read_skill_document", { slug: "expenses.read" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: document }]);
  });
});

const url = "https://example.com/api/items?q=a%2Bb&limit=1";
describe("mapped request arguments", () => {
  it.each([
    {
      label: "default GET with --connection",
      input: { url, connection: "work account" },
      argv: ["--connection=work account"],
    },
    {
      label: "explicit GET with repeated --scope/-s and --header/-H",
      input: {
        url,
        scope: ["items:read", "items:search"],
        headers: ["Accept: application/json", 'If-None-Match: "v1"'],
      },
      argv: [
        "--scope=items:read",
        "--scope=items:search",
        "--header=Accept: application/json",
        '--header=If-None-Match: "v1"',
      ],
    },
  ])("preserves $label and the full query string", async ({ input, argv }) => {
    const cli = { run: vi.fn().mockResolvedValue("{}") };
    const signal = new AbortController().signal;
    const result = await callTool(cli, "get", input, signal);
    expect(result.isError).not.toBe(true);
    expect(cli.run).toHaveBeenCalledExactlyOnceWith(
      ["request", "--method=GET", ...argv, url],
      signal,
      REQUEST_TIMEOUT,
    );
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "preserves explicit %s and --json as a JSON value",
    async (method) => {
      const cli = { run: vi.fn().mockResolvedValue("{}") };
      const json = { title: "'quoted' & $(not-a-command)", nested: [false, null, 3] };
      const result = await callTool(cli, "send", { url, method, connection: "work", json });
      expect(result.isError).not.toBe(true);
      expect(cli.run).toHaveBeenCalledExactlyOnceWith(
        [
          "request",
          `--method=${method}`,
          "--connection=work",
          `--json=${JSON.stringify(json)}`,
          url,
        ],
        undefined,
        REQUEST_TIMEOUT,
      );
    },
  );

  it("preserves --data as literal text", async () => {
    const cli = { run: vi.fn().mockResolvedValue("{}") };
    const text = "first line\n'quoted' & $(not-a-command)";
    const result = await callTool(cli, "send", { url, method: "PUT", scope: "items:write", text });
    expect(result.isError).not.toBe(true);
    expect(cli.run).toHaveBeenCalledExactlyOnceWith(
      ["request", "--method=PUT", "--scope=items:write", `--data=${text}`, url],
      undefined,
      REQUEST_TIMEOUT,
    );
  });

  it.each([
    { name: "get", input: { url, connection: "work", json: { body: true } } },
    { name: "send", input: { url, connection: "work", json: { body: true } } },
    { name: "send", input: { url, connection: "work", method: "HEAD" } },
    { name: "send", input: { url, connection: "work", method: "OPTIONS" } },
    { name: "send", input: { url, connection: "work", method: "POST", uploadFile: "/tmp/file" } },
    { name: "send", input: { url, connection: "work", method: "POST", form: ["file=@/tmp/file"] } },
    { name: "get", input: { url, connection: "work", output: "/tmp/file" } },
    { name: "get", input: { url, connection: "work", headers: ["Authorization: secret"] } },
  ])("rejects unsupported mapped arguments without dispatch (case %#)", async ({ name, input }) => {
    const cli = { run: vi.fn() };
    const result = await callTool(cli, name, input);
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
    expect(cli.run).not.toHaveBeenCalled();
  });
});
