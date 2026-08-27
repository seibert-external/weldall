import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeldallConfig } from "../src/config.js";

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../src/services/resources.js", () => ({
  prepareResourceClient: (...args: unknown[]) => state.prepare(...args),
}));

import { jsonPointerValue, paginateOffset } from "../src/pagination.js";

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
const base = "https://gateway.example/api/employees?fields=id";

beforeEach(() => {
  state.request.mockReset();
  state.prepare.mockReset();
  state.prepare.mockImplementation(async () => ({
    resource: {},
    scopes: ["employees:read"],
    request: state.request,
  }));
});

describe("offset pagination", () => {
  it("requests the first page once, bounds concurrency, and retains page order", async () => {
    let active = 0;
    let maximumActive = 0;
    state.request.mockImplementation(async ({ url }: { url: string }) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, offset === 100 ? 15 : 1));
      active--;
      return Response.json({ metadata: { total_pages: 4 }, offset });
    });
    const pages = await paginateOffset(config, {
      url: base,
      scopes: ["employees:read"],
      pageSize: 100,
      totalPagesPointer: "/metadata/total_pages",
      maxPages: 10,
      concurrency: 2,
    });
    expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.request).toHaveBeenCalledTimes(4);
    expect(
      state.request.mock.calls.map(([input]) => new URL(input.url).searchParams.get("offset")),
    ).toEqual(["0", "100", "200", "300"]);
    expect(pages.map((page) => page.offset)).toEqual([0, 100, 200, 300]);
    expect(maximumActive).toBeLessThanOrEqual(2);
  });

  it("rejects invalid pointers, page counts, and safety-limit overflow", async () => {
    state.request.mockResolvedValue(Response.json({ metadata: { total_pages: "three" } }));
    await expect(
      paginateOffset(config, {
        url: base,
        scopes: ["employees:read"],
        pageSize: 100,
        totalPagesPointer: "/metadata/total_pages",
        maxPages: 10,
        concurrency: 1,
      }),
    ).rejects.toThrow("integer greater than zero");

    state.request.mockResolvedValue(Response.json({ metadata: { total_pages: 11 } }));
    await expect(
      paginateOffset(config, {
        url: base,
        scopes: ["employees:read"],
        pageSize: 100,
        totalPagesPointer: "/metadata/total_pages",
        maxPages: 10,
        concurrency: 1,
      }),
    ).rejects.toThrow("exceeding --max-pages");

    state.request.mockResolvedValue(Response.json({ metadata: {} }));
    await expect(
      paginateOffset(config, {
        url: base,
        scopes: ["employees:read"],
        pageSize: 100,
        totalPagesPointer: "/metadata/total_pages",
        maxPages: 10,
        concurrency: 1,
      }),
    ).rejects.toThrow("did not resolve");
  });

  it("aborts outstanding work and reports the failed page and offset", async () => {
    let sawAbort = false;
    state.request.mockImplementation(
      async ({ url, signal }: { url: string; signal: AbortSignal }) => {
        const offset = Number(new URL(url).searchParams.get("offset"));
        if (offset === 0) return Response.json({ metadata: { total_pages: 3 }, offset });
        if (offset === 100) throw new Error("upstream unavailable");
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        throw new Error("aborted");
      },
    );
    await expect(
      paginateOffset(config, {
        url: base,
        scopes: ["employees:read"],
        pageSize: 100,
        totalPagesPointer: "/metadata/total_pages",
        maxPages: 10,
        concurrency: 2,
      }),
    ).rejects.toThrow("Page 2 at offset 100 failed");
    expect(sawAbort).toBe(true);
  });

  it("enforces the aggregate response byte limit while streaming", async () => {
    let cancelled = false;
    state.request.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"metada'));
            controller.enqueue(new TextEncoder().encode('ta":{"total_pages":1}}'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      paginateOffset(config, {
        url: base,
        scopes: ["employees:read"],
        pageSize: 100,
        totalPagesPointer: "/metadata/total_pages",
        maxPages: 10,
        concurrency: 1,
        maxResponseBytes: 10,
      }),
    ).rejects.toThrow("Page 1 at offset 0 failed");
    expect(cancelled).toBe(true);
  });

  it("validates direct-call numeric bounds", async () => {
    await expect(
      paginateOffset(config, {
        url: base,
        scopes: ["employees:read"],
        pageSize: 100,
        totalPagesPointer: "/metadata/total_pages",
        maxPages: 10,
        concurrency: 0,
      }),
    ).rejects.toThrow("Concurrency must be an integer");
    expect(state.prepare).not.toHaveBeenCalled();
  });
});

describe("RFC 6901 pointers", () => {
  it("decodes escaped object keys and rejects invalid escapes", () => {
    expect(jsonPointerValue({ "a/b": { "m~n": 3 } }, "/a~1b/m~0n")).toBe(3);
    expect(() => jsonPointerValue({}, "/bad~2escape")).toThrow("invalid RFC 6901 escape");
  });
});
