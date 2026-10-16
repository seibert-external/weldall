import { afterEach, describe, expect, it, vi } from "vitest";
import { createDpopProof } from "@weldall/sdk";
import { requestMcp } from "../src/services/mcp.js";
import type { WeldallConfig } from "../src/config.js";
vi.mock("@weldall/sdk", async (original) => ({
  ...(await original<object>()),
  createDpopProof: vi.fn().mockResolvedValue("proof"),
}));
vi.mock("../src/services/auth.js", () => ({
  withAccess: (_: unknown, run: (session: unknown) => unknown) =>
    run({ accessToken: "weldall-token", credentials: {} }),
}));
const config = { issuer: "https://weldall.example.com" } as WeldallConfig;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("private MCP JSON API client", () => {
  it("uses one fresh DPoP POST and preserves complete structured results", async () => {
    const result = {
      content: [{ type: "text", text: "error data" }],
      structuredContent: { nested: { value: 4 } },
      isError: true,
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      requestMcp(config, "call", {
        connectorKey: "work",
        connection: "mine",
        name: "write",
        arguments: { text: "body" },
      }),
    ).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toMatchObject([
      "https://weldall.example.com/api/me/mcp/connectors/work/call",
      {
        method: "POST",
        redirect: "error",
        headers: { authorization: "DPoP weldall-token", dpop: "proof" },
        body: JSON.stringify({ connection: "mine", name: "write", arguments: { text: "body" } }),
      },
    ]);
    expect(createDpopProof).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 429, 503])("never retries HTTP %i or exposes error bodies", async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("private upstream credential", { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      requestMcp(config, "call", { connectorKey: "work", connection: "mine", name: "write" }),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reports unsupported shipped servers without changing their requests", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(requestMcp(config, "list", {})).rejects.toThrow("does not support MCP");
  });
  it("rejects an excessive response before reading it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("[]", { headers: { "content-length": "20000000" } })),
    );
    await expect(requestMcp(config, "list", {})).rejects.toThrow("size limit");
  });
  it("rejects malformed results instead of returning arbitrary upstream metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ tools: "wrong" })));
    await expect(
      requestMcp(config, "tools", { connectorKey: "work", connection: "mine" }),
    ).rejects.toThrow("invalid MCP response");
  });
  it("rejects invalid dispatch names and endpoints locally", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const connectorKey of ["../admin", "https://elsewhere", "work/../../secrets"])
      await expect(
        requestMcp(config, "call", { connectorKey, connection: "mine", name: "read" }),
      ).rejects.toThrow("Invalid MCP");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not dispatch cancelled requests or replay network failures", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("private network diagnostic"));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestMcp(config, "list", {}, AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      requestMcp(config, "call", { connectorKey: "work", connection: "mine", name: "write" }),
    ).rejects.toThrow("was not retried");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
