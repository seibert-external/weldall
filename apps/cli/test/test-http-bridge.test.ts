import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpsDeadlineFetch } from "../src/http.js";
import {
  TEST_ORIGINAL_ORIGIN_HEADER,
  createTestHttpBridgeFetch,
  parseTestHttpBridge,
} from "../src/test-http-bridge.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("test HTTP transport bridge", () => {
  it("accepts only explicit HTTPS origins mapped to loopback HTTP origins", () => {
    expect(
      parseTestHttpBridge(
        JSON.stringify({ "https://issuer.example": "http://127.0.0.1:43123" }),
        "test",
      ),
    ).toEqual(new Map([["https://issuer.example", "http://127.0.0.1:43123"]]));
    for (const value of [
      { "http://issuer.example": "http://127.0.0.1:43123" },
      { "https://issuer.example/path": "http://127.0.0.1:43123" },
      { "https://issuer.example": "https://127.0.0.1:43123" },
      { "https://issuer.example": "http://localhost:43123" },
      { "https://issuer.example": "http://127.0.0.1:0" },
      { "https://issuer.example": "http://127.0.0.1/path" },
    ])
      expect(() => parseTestHttpBridge(JSON.stringify(value), "test")).toThrow();
  });

  it("rejects the hook outside tests", () => {
    expect(() =>
      parseTestHttpBridge(
        JSON.stringify({ "https://issuer.example": "http://127.0.0.1:43123" }),
        "production",
      ),
    ).toThrow("only allowed when NODE_ENV=test");
  });

  it("rewrites only allowlisted origins while preserving path, query, and HTTPS identity", async () => {
    const nativeFetch = vi.fn(async () => new Response("ok"));
    const bridged = createTestHttpBridgeFetch(
      new Map([["https://issuer.example", "http://127.0.0.1:43123"]]),
      nativeFetch,
    );
    await bridged("https://issuer.example/api/ü?q=space%20value", {
      method: "POST",
      headers: { accept: "application/json" },
      body: "payload",
    });
    const [input, init] = nativeFetch.mock.calls[0]!;
    expect(String(input)).toBe("http://127.0.0.1:43123/api/%C3%BC?q=space%20value");
    expect(new Headers(init?.headers).get(TEST_ORIGINAL_ORIGIN_HEADER)).toBe(
      "https://issuer.example",
    );
    expect(init?.body).toBe("payload");

    await bridged("https://unmapped.example/api");
    expect(nativeFetch.mock.calls[1]![0]).toBe("https://unmapped.example/api");
  });

  it("keeps deadline discovery on the installed bridge and rejects that seam in production", async () => {
    const nativeFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);
    vi.stubEnv("WELDALL_E2E_HTTP_BRIDGE", "{}");
    vi.stubEnv("NODE_ENV", "test");
    await expect(
      createHttpsDeadlineFetch(1_000)("https://issuer.example/metadata"),
    ).resolves.toBeInstanceOf(Response);
    expect(nativeFetch).toHaveBeenCalledOnce();

    vi.stubEnv("NODE_ENV", "production");
    await expect(
      createHttpsDeadlineFetch(1_000)("https://issuer.example/metadata"),
    ).rejects.toThrow("only allowed when NODE_ENV=test");
  });

  it("does not allow a caller to forge the bridge identity header", async () => {
    const bridged = createTestHttpBridgeFetch(
      new Map([["https://issuer.example", "http://127.0.0.1:43123"]]),
      vi.fn(async () => new Response()),
    );
    await expect(
      bridged("https://issuer.example/api", {
        headers: { [TEST_ORIGINAL_ORIGIN_HEADER]: "https://attacker.example" },
      }),
    ).rejects.toThrow("reserved");
  });
});
