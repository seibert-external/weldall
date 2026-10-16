import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  createWeldallMcpClient,
  generateEs256KeyPair,
  inMemory,
  verifyStrictDpop,
} from "../src/index.js";
import { MCP_LIMITS } from "../src/mcp/contracts.js";
const issuer = "https://weldall.example.com";
describe("machine MCP client", () => {
  it("signs fresh DPoP proofs with the exact method/URL/token and validates responses", async () => {
    const key = await generateEs256KeyPair();
    const seen = new Set<string>();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const proof = new Headers(init?.headers).get("dpop")!;
      const verified = await verifyStrictDpop(proof, {
        method: init!.method!,
        url: String(url),
        accessToken: "token",
        expectedJkt: key.jkt,
        replay: inMemory(),
      });
      expect(seen.has(verified.payload.jti)).toBe(false);
      seen.add(verified.payload.jti);
      expect(init?.redirect).toBe("error");
      return Response.json(
        String(url).endsWith("/tools")
          ? { tools: [] }
          : { content: [{ type: "text", text: "ok" }] },
      );
    });
    const client = createWeldallMcpClient({ issuer, accessToken: "token", key, fetch: fetcher });
    await client.listTools({ connectorKey: "atlassian", connection: "production-bot" });
    await client.callTool({
      connectorKey: "atlassian",
      connection: "production-bot",
      name: "read",
      arguments: {},
    });
    expect(seen.size).toBe(2);
  });
  it.each([401, 403, 429, 502])(
    "does not retry HTTP %s or expose upstream secrets",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response("private-secret", { status }));
      const client = createWeldallMcpClient({
        issuer,
        accessToken: "token",
        key: await generateEs256KeyPair(),
        fetch: fetcher,
      });
      await expect(
        client.callTool({
          connectorKey: "atlassian",
          connection: "bot",
          name: "write",
          arguments: {},
        }),
      ).rejects.toMatchObject({ code: "request_failed", status });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("rejects malformed/oversized input and output, and does not retry ambiguous transport failures", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("private-secret");
    });
    const client = createWeldallMcpClient({
      issuer,
      accessToken: "token",
      key: await generateEs256KeyPair(),
      fetch: fetcher,
    });
    expect(() =>
      client.callTool({
        connectorKey: "atlassian",
        connection: "bot",
        name: "write",
        arguments: { huge: "x".repeat(MCP_LIMITS.requestBytes) },
      }),
    ).toThrow("invalid_request");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      client.callTool({
        connectorKey: "atlassian",
        connection: "bot",
        name: "write",
        arguments: {},
      }),
    ).rejects.toThrow("request_failed");
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockImplementation(async () => Response.json({ tools: "wrong" }));
    await expect(
      client.listTools({ connectorKey: "atlassian", connection: "bot" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    fetcher.mockImplementation(
      async () =>
        new Response("", { headers: { "content-length": String(MCP_LIMITS.resultBytes + 1) } }),
    );
    await expect(
      client.listTools({ connectorKey: "atlassian", connection: "bot" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("keeps exported Python structural contracts synchronized", () => {
    expect(
      JSON.parse(
        readFileSync(
          new URL("../../python-sdk/src/weldall/mcp-contracts.json", import.meta.url),
          "utf8",
        ),
      ).limits,
    ).toEqual(MCP_LIMITS);
    execFileSync("pnpm", ["exec", "tsx", "scripts/export-mcp-contracts.ts", "--check"], {
      cwd: new URL("..", import.meta.url),
    });
  });
});
