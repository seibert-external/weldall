import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAuthorization,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  createPinnedFetch,
  isPublicIpv4,
  resolvePublicIpv4,
} from "../src/server/connectors/core/secure-fetch";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
afterEach(() => vi.clearAllMocks());
function wire(
  options: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    maximum?: number;
  } = {},
) {
  const response = Object.assign(new PassThrough(), {
    statusCode: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
    complete: true,
  });
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  req.end.mockImplementation(() =>
    queueMicrotask(() => {
      req.emit("response", response);
      if (!response.destroyed) response.end(options.body ?? "{}");
    }),
  );
  req.destroy.mockImplementation(() => req.emit("close"));
  const request = vi.fn(() => req);
  const fetcher = createPinnedFetch({
    validateUrl: () => {},
    signal: AbortSignal.timeout(1000),
    maximumBytes: options.maximum ?? 100,
    request: request as unknown as typeof import("node:https").request,
  });
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  return { request, fetcher, req };
}
describe("DNS-pinned HTTPS transport", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "198.18.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
  ])("rejects special-use destination %s", (address) => expect(isPublicIpv4(address)).toBe(false));
  it("fails closed on mixed public/private DNS", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ] as never);
    await expect(resolvePublicIpv4("reviewed.example")).rejects.toThrow();
  });
  it("pins the vetted address into TLS while preserving hostname verification", async () => {
    const { fetcher, request } = wire();
    expect(await (await fetcher("https://reviewed.example/mcp")).json()).toEqual({});
    const options = (
      request.mock.calls[0] as unknown as Parameters<typeof import("node:https").request>
    )[1] as import("node:https").RequestOptions;
    expect(options).toMatchObject({
      servername: "reviewed.example",
      family: 4,
      agent: false,
      headers: { "accept-encoding": "identity" },
    });
    expect(options.rejectUnauthorized).not.toBe(false);
    const callback = vi.fn();
    options.lookup!("reviewed.example", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });
  it.each(["authorization_code", "refresh_token"] as const)(
    "sends the SDK's %s form through the pinned adapter",
    async (grantType) => {
      const tokens = { access_token: "access", refresh_token: "refresh", token_type: "Bearer" };
      const { fetcher, req, request } = wire({ body: JSON.stringify(tokens) });
      const options = {
        clientInformation: { client_id: "public-client", token_endpoint_auth_method: "none" },
        fetchFn: fetcher,
      };
      const result =
        grantType === "authorization_code"
          ? await exchangeAuthorization("https://reviewed.example", {
              ...options,
              authorizationCode: "code+with & symbols",
              codeVerifier: "v".repeat(43),
              redirectUri: "https://weldall.example.com/callback",
            })
          : await refreshAuthorization("https://reviewed.example", {
              ...options,
              refreshToken: "refresh+with & symbols",
            });
      expect(result).toEqual(tokens);
      expect(request).toHaveBeenCalledOnce();
      const body = new URLSearchParams(req.end.mock.calls[0]![0].toString());
      expect(body.get("grant_type")).toBe(grantType);
      expect(body.get("client_id")).toBe("public-client");
      expect(body.get(grantType === "authorization_code" ? "code" : "refresh_token")).toBe(
        grantType === "authorization_code" ? "code+with & symbols" : "refresh+with & symbols",
      );
    },
  );
  it("checks the encoded size of form bodies before dispatch", async () => {
    const { fetcher, request } = wire();
    await expect(
      fetcher("https://reviewed.example/token", {
        method: "POST",
        body: new URLSearchParams({ code: "&".repeat(400_000) }),
      }),
    ).rejects.toMatchObject({ code: "request_too_large" });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["host", "cookie", "proxy-authorization", "forwarded", "x-forwarded-host", "dpop"])(
    "refuses caller-owned %s headers before dispatch",
    async (header) => {
      const { fetcher, request } = wire();
      await expect(
        fetcher("https://reviewed.example/mcp", { headers: { [header]: "sentinel" } }),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: 307, headers: { location: "https://other.example" } },
    { headers: { "content-encoding": "gzip" } },
    { headers: { "content-length": "500" } },
  ])("rejects redirects, compression and oversized declared bodies", async (options) => {
    const { fetcher, request } = wire(options);
    await expect(fetcher("https://reviewed.example/mcp")).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it("bounds streamed response bytes without buffering the entire body", async () => {
    const { fetcher } = wire({ body: "x".repeat(101) });
    const response = await fetcher("https://reviewed.example/mcp");
    await expect(response.text()).rejects.toMatchObject({ code: "response_too_large" });
  });
  it("refuses non-HTTPS, ports and cancellation without a request", async () => {
    const { fetcher, request } = wire();
    for (const url of [
      "http://reviewed.example/mcp",
      "https://reviewed.example:8443/mcp",
      "https://user:pass@reviewed.example/mcp",
    ])
      await expect(fetcher(url)).rejects.toThrow();
    await expect(
      fetcher("https://reviewed.example/mcp", { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
