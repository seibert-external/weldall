import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { PassThrough } from "node:stream";
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

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
vi.mock("../src/server/observability/logger.js", () => ({
  errorForLog: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }),
  logger: loggerMocks,
}));

const runId = randomUUID();
const userId = `user-avatar-${runId}`;
const email = `user-avatar-${runId}@example.com`;
const lookupMock = vi.mocked(lookup);
const requestMock = vi.mocked(request);
type PinnedLookup = (
  hostname: string,
  options: object,
  callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

afterAll(async () => {
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
    mockAvatarRequest({
      addresses: [{ address: "8.8.8.8", family: 4 }],
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
    expect(lookupMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "user_avatar.fetch.failed", reason: "invalid_url" }),
      "Failed to fetch provider avatar",
    );
  });

  it("refuses direct private, loopback and link-local addresses without a request", async () => {
    await expect(fetchAvatarImage("https://127.0.0.1/a.png")).resolves.toBeNull();
    await expect(fetchAvatarImage("https://10.1.2.3/a.png")).resolves.toBeNull();
    await expect(fetchAvatarImage("https://169.254.169.254/latest.png")).resolves.toBeNull();
    await expect(fetchAvatarImage("https://[::1]/a.png")).resolves.toBeNull();
    await expect(fetchAvatarImage("https://[fe80::1]/a.png")).resolves.toBeNull();

    expect(lookupMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "user_avatar.fetch.failed",
        hostname: "fe80::1",
        reason: "address_not_public",
      }),
      "Failed to fetch provider avatar",
    );
  });

  it("refuses DNS answers that include private addresses without a request", async () => {
    lookupMock.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(fetchAvatarImage("https://photos.example.com/a.png")).resolves.toBeNull();

    expect(lookupMock).toHaveBeenCalledWith("photos.example.com", { all: true, verbatim: true });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("pins the request lookup to the validated public address", async () => {
    mockAvatarRequest({
      addresses: [
        { address: "8.8.8.8", family: 4 },
        { address: "8.8.4.4", family: 4 },
      ],
      body: new Uint8Array([1]),
      headers: { "content-type": "image/png" },
    });

    await expect(fetchAvatarImage("https://photos.example.com/a.png")).resolves.toMatchObject({
      contentType: "image/png",
    });

    const options = requestMock.mock.calls[0]![1] as { lookup: PinnedLookup };
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      options.lookup("photos.example.com", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family: Number(family) });
      });
    });
    expect(resolved).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("treats redirects, non-raster responses and oversized declarations as missing", async () => {
    mockAvatarRequest({
      statusCode: 302,
      headers: { location: "https://elsewhere.example.com" },
    });
    await expect(fetchAvatarImage("https://photos.example.com/a.png")).resolves.toBeNull();

    mockAvatarRequest({ body: "<html></html>", headers: { "content-type": "text/html" } });
    await expect(fetchAvatarImage("https://photos.example.com/a.png")).resolves.toBeNull();

    mockAvatarRequest({
      body: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      headers: { "content-type": "image/svg+xml" },
    });
    await expect(fetchAvatarImage("https://photos.example.com/a.svg")).resolves.toBeNull();

    mockAvatarRequest({
      headers: { "content-type": "image/png", "content-length": String(1024 * 1024) },
    });
    await expect(fetchAvatarImage("https://photos.example.com/huge.png")).resolves.toBeNull();
  });

  it("stops reading a body that exceeds the size limit", async () => {
    const chunk = new Uint8Array(64 * 1_024);
    mockAvatarRequest({
      body: Array.from({ length: 16 }, () => chunk),
      headers: { "content-type": "image/png" },
    });

    await expect(fetchAvatarImage("https://photos.example.com/huge.png")).resolves.toBeNull();
  });

  it("terminates a response body that stalls after headers", async () => {
    vi.useFakeTimers();
    let response: IncomingMessage | undefined;
    mockAvatarRequest({
      headers: { "content-type": "image/png" },
      onResponse: (stream) => {
        response = stream;
      },
      stallBody: true,
    });

    const image = fetchAvatarImage("https://photos.example.com/stalled.png");
    await vi.advanceTimersByTimeAsync(0);
    expect(response).toBeDefined();

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(image).resolves.toBeNull();
    expect(response!.destroy).toHaveBeenCalled();
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

function mockAvatarRequest(input: {
  addresses?: Array<{ address: string; family: 4 | 6 }>;
  body?: string | Uint8Array | Uint8Array[];
  headers?: Record<string, string>;
  onResponse?: (response: IncomingMessage) => void;
  statusCode?: number;
  stallBody?: boolean;
}): void {
  lookupMock.mockResolvedValue(input.addresses ?? [{ address: "8.8.8.8", family: 4 }]);
  requestMock.mockImplementation(((_url, _options, callback) => {
    const responseCallback = callback as (response: IncomingMessage) => void;
    const clientRequest = new EventEmitter() as EventEmitter & {
      destroy: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    clientRequest.destroy = vi.fn();
    clientRequest.end = vi.fn(() => {
      const response = new PassThrough() as IncomingMessage;
      response.statusCode = input.statusCode ?? 200;
      response.headers = input.headers ?? { "content-type": "image/png" };
      response.destroy = vi.fn(response.destroy.bind(response));
      queueMicrotask(() => {
        responseCallback(response);
        input.onResponse?.(response);
        if (input.stallBody) return;
        const body = input.body ?? new Uint8Array();
        if (Array.isArray(body)) {
          for (const chunk of body) response.write(chunk);
          response.end();
        } else {
          response.end(body);
        }
      });
    });
    return clientRequest;
  }) as typeof request);
}
