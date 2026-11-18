import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { buildInstructions, PROTOCOL_VERSIONS } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture, organizationInstructions } from "./fixture.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = path.join(root, "dist/index.js");
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root });
});

describe.skipIf(process.platform === "win32")("real stdio MCP", () => {
  it("initializes, lists and calls all six tools through the CLI", async () => {
    const f = await fixture();
    const calls = path.join(f.root, "calls");
    const client = new Client({ name: "test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: f.cwd,
      env: { ...f.env, FAKE_CALLS: calls } as Record<string, string>,
      stderr: "pipe",
    });
    let errors = "";
    transport.stderr?.on("data", (chunk) => {
      errors += chunk.toString();
    });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toBe(buildInstructions(organizationInstructions));
      expect(client.getInstructions()).not.toContain("should-not-escape");
      expect(client.getInstructions()).toContain("CLI-to-MCP mapping:");
      expect(client.getInstructions()).toContain(
        "never use a read/search/list/lookup/review skill",
      );
      expect(client.getInstructions()).toContain(
        "Before asking the user to confirm a provider write",
      );
      expect(client.getInstructions()).toContain("including a read-only POST query transport");
      expect(await client.ping()).toEqual({});
      expect((await client.listTools()).tools).toHaveLength(6);
      for (const [name, args] of [
        ["search_skills", { query: "expenses" }],
        ["list_skills", {}],
        ["read_skill_document", { slug: "expenses.review" }],
        ["list_connections", {}],
        ["get", { url: "https://example.com/api", scope: "expenses:read" }],
        [
          "send",
          {
            url: "https://example.com/api",
            connection: "work",
            requiredScopes: ["mail:read"],
            method: "POST",
            json: { amount: 24 },
          },
        ],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).not.toContain("should-not-escape");
        if (name === "list_connections") {
          expect(result.structuredContent).toEqual({
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
      const invalid = await client.callTool({ name: "send", arguments: { method: "GET" } });
      expect(invalid.isError).toBe(true);
      await expect(client.callTool({ name: "shell", arguments: {} })).rejects.toThrow(
        "Unknown tool",
      );
      const recorded = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(recorded).toHaveLength(7);
      expect(recorded[0]).toEqual(["status", "--json"]);
      expect(errors).toBe("");
    } finally {
      await client.close();
      await f.cleanup();
    }
  });
  it.each([
    [JSON.stringify({ identity: "should-not-escape" }), "Update the local Weldall binary"],
    [
      JSON.stringify({ organizationInstructions: null }),
      "organization instructions could not be loaded",
    ],
    ["malformed-secret", "invalid response"],
  ])(
    "does not initialize without usable organization context (case %#)",
    async (status, message) => {
      const f = await fixture();
      const child = spawn(process.execPath, [entry], {
        cwd: f.cwd,
        env: { ...f.env, FAKE_STATUS: status },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      try {
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.stdin.end();
        expect(await closed).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain(message);
        expect(stderr).not.toContain("should-not-escape");
        expect(stderr).not.toContain("malformed-secret");
      } finally {
        child.kill();
        await f.cleanup();
      }
    },
  );
  it("delivers CLI stderr as a tool error without corrupting stdio", async () => {
    const f = await fixture();
    const client = new Client({ name: "test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: f.cwd,
      env: { ...f.env, FAKE_ERROR: "1" } as Record<string, string>,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "list_skills", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          exitCode: 3,
          stderr: "Missing scope: expenses:read\nAsk for access, then run weldall login.",
        },
      });
      expect(await client.ping()).toEqual({});
    } finally {
      await client.close();
      await f.cleanup();
    }
  });
  it("propagates MCP cancellation to the child without replay", async () => {
    const f = await fixture();
    const client = new Client({ name: "test", version: "1" });
    const pidFile = path.join(f.root, "pid");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: f.cwd,
      env: { ...f.env, FAKE_WAIT: "1", FAKE_PID: pidFile } as Record<string, string>,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const controller = new AbortController();
      const call = client.callTool({ name: "list_skills", arguments: {} }, undefined, {
        signal: controller.signal,
      });
      const assertion = expect(call).rejects.toThrow();
      await expect.poll(async () => readFile(pidFile, "utf8")).toBeTruthy();
      const pid = Number(await readFile(pidFile, "utf8"));
      controller.abort();
      await assertion;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
    } finally {
      await client.close();
      await f.cleanup();
    }
  });
  it.each([...PROTOCOL_VERSIONS, "2099-01-01"])("explicitly negotiates %s", async (version) => {
    const f = await fixture();
    const child = spawn(process.execPath, [entry], {
      cwd: f.cwd,
      env: f.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    try {
      const response = new Promise<string>((resolve) => lines.once("line", resolve));
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }) + "\n",
      );
      const message = JSON.parse(await response);
      expect(message.result.protocolVersion).toBe(
        PROTOCOL_VERSIONS.includes(version as (typeof PROTOCOL_VERSIONS)[number])
          ? version
          : PROTOCOL_VERSIONS[0],
      );
      expect(message.result.instructions).toBe(buildInstructions(organizationInstructions));
    } finally {
      lines.close();
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.stdin.end();
      await closed;
      await f.cleanup();
    }
  });
  it.each(["malformed", "oversized"])("closes safely on %s input", async (kind) => {
    const f = await fixture();
    const child = spawn(process.execPath, [entry], {
      cwd: f.cwd,
      env: f.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on("error", () => undefined);
    try {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.stdin.write(kind === "malformed" ? "not-json-secret\n" : "x".repeat(300_000));
      await closed;
      expect(stderr).toContain("Invalid MCP input");
      expect(stderr).not.toContain("secret");
    } finally {
      child.kill();
      await f.cleanup();
    }
  });
  it.each(["eof", "SIGTERM"])("%s stops active CLI work", async (stop) => {
    const f = await fixture();
    const pidFile = path.join(f.root, "pid");
    const child = spawn(process.execPath, [entry], {
      cwd: f.cwd,
      env: { ...f.env, FAKE_WAIT: "1", FAKE_PID: pidFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      const initialized = new Promise((resolve) => lines.once("line", resolve));
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }) + "\n",
      );
      await initialized;
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_skills", arguments: {} },
        }) + "\n",
      );
      await expect.poll(async () => readFile(pidFile, "utf8")).toBeTruthy();
      const pid = Number(await readFile(pidFile, "utf8"));
      if (stop === "eof") child.stdin.end();
      else child.kill("SIGTERM");
      await closed;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      lines.close();
      child.kill();
      await f.cleanup();
    }
  });
});
