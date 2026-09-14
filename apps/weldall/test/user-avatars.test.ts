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

const runId = randomUUID();
const userId = `user-avatar-${runId}`;
const email = `user-avatar-${runId}@example.com`;

afterAll(async () => {
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
});

describe("avatar fetching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns bounded raster bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(bytes, {
            status: 200,
            headers: { "content-type": "image/png; charset=binary" },
          }),
      ),
    );

    const image = await fetchAvatarImage("https://photos.example.com/a.png");

    expect(image?.contentType).toBe("image/png");
    expect([...new Uint8Array(image!.body)]).toEqual([1, 2, 3]);
  });

  it("refuses URLs it cannot serve without contacting the provider", async () => {
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);

    await expect(fetchAvatarImage("http://photos.example.com/a.png")).resolves.toBeNull();
    await expect(fetchAvatarImage("not a url")).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("treats redirects, non-raster responses and oversized declarations as missing", async () => {
    const respond = (response: Response) =>
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => response),
      );

    respond(
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } }),
    );
    await expect(fetchAvatarImage("https://photos.example.com/a.png")).resolves.toBeNull();

    respond(
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await expect(fetchAvatarImage("https://photos.example.com/a.png")).resolves.toBeNull();

    respond(
      new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );
    await expect(fetchAvatarImage("https://photos.example.com/a.svg")).resolves.toBeNull();

    respond(
      new Response(new ReadableStream({ start: (controller) => controller.close() }), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(1024 * 1024) },
      }),
    );
    await expect(fetchAvatarImage("https://photos.example.com/huge.png")).resolves.toBeNull();
  });

  it("stops reading a body that exceeds the size limit", async () => {
    const chunk = new Uint8Array(64 * 1_024);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (let index = 0; index < 16; index += 1) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "image/png" } },
          ),
      ),
    );

    await expect(fetchAvatarImage("https://photos.example.com/huge.png")).resolves.toBeNull();
  });
});

describe("provider avatar cache", () => {
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
