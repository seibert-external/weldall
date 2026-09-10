import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { oidcFetch } from "../src/server/auth/oidc-transport";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const request = (url = "https://id.example.com/config", signal = new AbortController().signal) =>
  oidcFetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    body: undefined,
    redirect: "manual",
    signal,
  });

it("permits private HTTPS using Fetch's default TLS verification and preserves the library signal", async () => {
  const signal = new AbortController().signal;
  expect(await (await request("https://127.0.0.1/jwks", signal)).json()).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledWith("https://127.0.0.1/jwks", {
    method: "GET",
    headers: { accept: "application/json" },
    body: null,
    redirect: "manual",
    signal,
  });
});
it.each([
  "http://id.example.com",
  "https://user:password@id.example.com",
  "https://id.example.com/#fragment",
])("rejects URL %s before sending credentials", async (url) => {
  await expect(request(url)).rejects.toThrow("upstream_unavailable");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("never redirects/forwards credentials, cancels redirects and keeps status/error JSON for the library", async () => {
  const cancel = vi.fn();
  fetchMock.mockResolvedValueOnce(
    new Response(new ReadableStream({ cancel }), {
      status: 302,
      headers: { "content-type": "application/json", location: "https://evil.example.com" },
    }),
  );
  await expect(
    oidcFetch("https://id.example.com/token", {
      method: "POST",
      headers: { authorization: "Basic secret" },
      body: new URLSearchParams({ code: "code" }),
      redirect: "manual",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("upstream_unavailable");
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
  const response = await request();
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_grant" });
  expect(new Headers(fetchMock.mock.calls[1]![1]!.headers).has("authorization")).toBe(false);
});
it.each(["text/html", "application/jsonp", "text/json", ""])(
  "cancels invalid media type %s",
  async (contentType) => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), { headers: { "content-type": contentType } }),
    );
    await expect(request()).rejects.toThrow("upstream_unavailable");
    expect(cancel).toHaveBeenCalledOnce();
  },
);
it.each(["application/json", "application/jwk-set+json", "Application/JSON; charset=utf-8"])(
  "accepts JSON media type %s without parsing/rebuilding protocol JSON",
  async (contentType) => {
    fetchMock.mockResolvedValueOnce(
      new Response("not-json", { headers: { "content-type": contentType } }),
    );
    expect(await (await request()).text()).toBe("not-json");
  },
);
it("caps chunked bytes, not declared Content-Length, and cancels oversized bodies", async () => {
  const cancel = vi.fn();
  let chunks = 0;
  fetchMock.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(128 * 1024));
          chunks++;
        },
        cancel,
      }),
      { headers: { "content-type": "application/json", "content-length": "1" } },
    ),
  );
  await expect(request()).rejects.toThrow("upstream_unavailable");
  expect(cancel).toHaveBeenCalledOnce();
  expect(chunks).toBeLessThanOrEqual(4);
  fetchMock.mockResolvedValueOnce(
    new Response(new Uint8Array(256 * 1024), { headers: { "content-type": "application/json" } }),
  );
  expect((await (await request()).arrayBuffer()).byteLength).toBe(256 * 1024);
});
it("honors abort during stalled connection establishment", async () => {
  fetchMock.mockImplementationOnce(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
          once: true,
        });
      }),
  );
  await expect(request(undefined, AbortSignal.timeout(20))).rejects.toThrow("upstream_unavailable");
});
it("honors abort during a slow response body and cancels it", async () => {
  const cancel = vi.fn();
  fetchMock.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([123]));
        },
        cancel,
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await expect(request(undefined, AbortSignal.timeout(20))).rejects.toThrow("upstream_unavailable");
  expect(cancel).toHaveBeenCalledOnce();
});
it("sanitizes TLS/network and body read failures", async () => {
  fetchMock.mockRejectedValueOnce(new Error("certificate rejected: sensitive destination"));
  const failure = await request().catch((error: Error) => error);
  expect(failure).toMatchObject({ message: "upstream_unavailable" });
  expect(failure).not.toHaveProperty("cause");
  fetchMock.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("body secret"));
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await expect(request()).rejects.toThrow("upstream_unavailable");
});
