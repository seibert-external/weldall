import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAvatarImage: vi.fn(),
  getSession: vi.fn(),
  loadAvatarUrl: vi.fn(),
}));

vi.mock("../src/server/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("../src/server/avatars", () => ({
  fetchAvatarImage: mocks.fetchAvatarImage,
  loadAvatarUrl: mocks.loadAvatarUrl,
}));
vi.mock("../src/server/observability/http", () => ({
  withRequestLogging: (_route: string, handler: unknown) => handler,
}));

import { GET } from "../src/app/api/avatars/[userId]/route";

const request = new Request("https://weldall.example.com/api/avatars/user-a");
const context = { params: Promise.resolve({ userId: "user-a" }) };

describe("avatar route", () => {
  beforeEach(() => {
    mocks.getSession.mockReset().mockResolvedValue({ user: { id: "session-user" } });
    mocks.loadAvatarUrl.mockReset().mockResolvedValue("https://photos.example.com/user-a.png");
    mocks.fetchAvatarImage
      .mockReset()
      .mockResolvedValue({ body: new ArrayBuffer(3), contentType: "image/png" });
  });

  it("requires a session but no scope", async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await GET(request, context);

    expect(response.status).toBe(401);
    expect(mocks.loadAvatarUrl).not.toHaveBeenCalled();
  });

  it("serves the cached avatar through the Weldall origin", async () => {
    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=600, stale-while-revalidate=3600",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.loadAvatarUrl).toHaveBeenCalledWith("user-a");
    expect(mocks.fetchAvatarImage).toHaveBeenCalledWith("https://photos.example.com/user-a.png");
  });

  it("answers 404 when no avatar is cached", async () => {
    mocks.loadAvatarUrl.mockResolvedValue(null);

    const response = await GET(request, context);

    expect(response.status).toBe(404);
    expect(mocks.fetchAvatarImage).not.toHaveBeenCalled();
  });

  it("answers 404 when the provider does not serve an image", async () => {
    mocks.fetchAvatarImage.mockResolvedValue(null);

    const response = await GET(request, context);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
