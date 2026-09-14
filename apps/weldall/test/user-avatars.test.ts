import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import {
  avatarRoutePath,
  cacheProviderAvatar,
  fetchAvatarImage,
  loadAvatarUrl,
} from "../src/server/avatars.js";
import { parseAvatarUrl } from "../src/server/group-providers/avatar-url.js";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../src/server/observability/logger.js", () => ({
  errorForLog: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }),
  logger: loggerMocks,
}));

const runId = randomUUID();
const userId = `user-avatar-${runId}`;
const email = `user-avatar-${runId}@example.com`;
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!process.env.POSTGRES_URL) return;
  await db.user.deleteMany({ where: { id: userId } });
});

describe("avatar URLs", () => {
  it("accepts only absolute HTTPS URLs without credentials or a fragment", () => {
    expect(parseAvatarUrl("https://photos.example.com/a.png")).toBe(
      "https://photos.example.com/a.png",
    );
    expect(parseAvatarUrl("  https://photos.example.com/a.png?v=2  ")).toBe(
      "https://photos.example.com/a.png?v=2",
    );
    expect(parseAvatarUrl("http://photos.example.com/a.png")).toBeNull();
    expect(parseAvatarUrl("https://user:secret@photos.example.com/a.png")).toBeNull();
    expect(parseAvatarUrl("https://photos.example.com/a.png#fragment")).toBeNull();
    expect(parseAvatarUrl(`https://photos.example.com/${"a".repeat(2_048)}.png`)).toBeNull();
    expect(parseAvatarUrl("not a url")).toBeNull();
    expect(parseAvatarUrl("")).toBeNull();
    expect(parseAvatarUrl(null)).toBeNull();
    expect(parseAvatarUrl(42)).toBeNull();
  });

  it("builds a same-origin path for a user", () => {
    expect(avatarRoutePath("user/a")).toBe("/api/avatars/user%2Fa");
  });

  it("logs why an unusable provider avatar is not cached", async () => {
    await cacheProviderAvatar(email, "http://photos.example.com/a.png");

    expect(loggerMocks.debug).toHaveBeenCalledWith(
      { event: "user_avatar.cache.skipped", reason: "invalid_url" },
      "Skipped group provider avatar cache",
    );
  });
});

describe("avatar fetching", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("returns bounded raster bytes", async () => {
    mockAvatarFetch({
      body: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "image/png; charset=binary" },
    });

    const image = await fetchAvatarImage("https://photos.example.com/a.png");

    expect(image?.contentType).toBe("image/png");
    expect([...new Uint8Array(image!.body)]).toEqual([1, 2, 3]);
  });

  it("refuses URLs it cannot serve without contacting the provider", async () => {
    await expect(fetchAvatarImage("http://photos.example.com/a.png")).resolves.toBeNull();
    await expect(fetchAvatarImage("not a url")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "user_avatar.fetch.failed", reason: "invalid_url" }),
      "Failed to fetch provider avatar",
    );
  });

  it("allows trusted providers to serve avatars from internal HTTPS hosts", async () => {
    mockAvatarFetch({ body: new Uint8Array([1]), headers: { "content-type": "image/png" } });

    await expect(fetchAvatarImage("https://10.1.2.3/a.png")).resolves.toMatchObject({
      contentType: "image/png",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://10.1.2.3/a.png",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("treats redirects, non-raster responses and oversized declarations as missing", async () => {
    mockAvatarFetch({
      statusCode: 302,
      headers: { location: "https://elsewhere.example.com" },
    });
    await expect(fetchAvatarImage("https://photos.example.com/a.png")).resolves.toBeNull();

    mockAvatarFetch({ body: "<html></html>", headers: { "content-type": "text/html" } });
    await expect(fetchAvatarImage("https://photos.example.com/a.png")).resolves.toBeNull();

    mockAvatarFetch({
      body: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      headers: { "content-type": "image/svg+xml" },
    });
    await expect(fetchAvatarImage("https://photos.example.com/a.svg")).resolves.toBeNull();

    mockAvatarFetch({
      headers: { "content-type": "image/png", "content-length": String(1024 * 1024) },
    });
    await expect(fetchAvatarImage("https://photos.example.com/huge.png")).resolves.toBeNull();
  });

  it("stops reading a body that exceeds the size limit", async () => {
    const chunk = new Uint8Array(64 * 1_024);
    mockAvatarFetch({
      body: Array.from({ length: 16 }, () => chunk),
      headers: { "content-type": "image/png" },
    });

    await expect(fetchAvatarImage("https://photos.example.com/huge.png")).resolves.toBeNull();
  });

  it("terminates a response body that stalls after headers", async () => {
    vi.useFakeTimers();
    const onAbort = vi.fn();
    mockAvatarFetch({
      headers: { "content-type": "image/png" },
      onAbort,
      stallBody: true,
    });

    const image = fetchAvatarImage("https://photos.example.com/stalled.png");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(image).resolves.toBeNull();
    expect(onAbort).toHaveBeenCalled();
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "user_avatar.fetch.failed",
        hostname: "photos.example.com",
        reason: "timeout",
      }),
      "Failed to fetch provider avatar",
    );
  });
});

describe.skipIf(!process.env.POSTGRES_URL)("provider avatar cache", () => {
  it("stores the provider avatar by normalized email and reports it for the user", async () => {
    await db.user.create({
      data: { id: userId, name: "Avery Analyst", email, emailVerified: true },
    });

    await cacheProviderAvatar(`  ${email.toUpperCase()}  `, "https://photos.example.com/avery.png");
    await expect(loadAvatarUrl(userId)).resolves.toBe("https://photos.example.com/avery.png");

    // An unusable URL leaves the cached value alone.
    await cacheProviderAvatar(email, "http://photos.example.com/avery.png");
    await expect(loadAvatarUrl(userId)).resolves.toBe("https://photos.example.com/avery.png");

    await expect(loadAvatarUrl(`user-avatar-missing-${runId}`)).resolves.toBeNull();
  });
});

function mockAvatarFetch(input: {
  body?: string | Uint8Array | Uint8Array[];
  headers?: Record<string, string>;
  onAbort?: () => void;
  statusCode?: number;
  stallBody?: boolean;
}): void {
  fetchMock.mockImplementationOnce(async (_url, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (input.stallBody) {
          init?.signal?.addEventListener(
            "abort",
            () => {
              input.onAbort?.();
              controller.error(init.signal?.reason);
            },
            { once: true },
          );
          return;
        }
        const body = input.body ?? new Uint8Array();
        const chunks = Array.isArray(body) ? body : [body];
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: input.statusCode ?? 200,
      headers: input.headers ?? { "content-type": "image/png" },
    });
  });
}
