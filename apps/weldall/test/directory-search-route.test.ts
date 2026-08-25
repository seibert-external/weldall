import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  getSession: vi.fn(),
  listSearchablePrimitives: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("../src/server/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("../src/server/directory/search", () => ({
  listSearchablePrimitives: mocks.listSearchablePrimitives,
}));
vi.mock("../src/server/skills/catalogs", () => ({ refreshDueCatalogs: vi.fn() }));

import { GET } from "../src/app/api/directory/primitives/route";

describe("directory primitive search route", () => {
  beforeEach(() => {
    mocks.after.mockReset();
    mocks.getSession.mockReset().mockResolvedValue(null);
    mocks.listSearchablePrimitives.mockReset().mockResolvedValue([]);
  });

  it("rejects anonymous requests without loading directory data", async () => {
    const response = await GET(new Request("https://weldall.example/api/directory/primitives"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mocks.listSearchablePrimitives).not.toHaveBeenCalled();
  });

  it("returns a private compact index for the authenticated user", async () => {
    mocks.getSession.mockResolvedValue({ user: { email: "user@example.com" } });
    mocks.listSearchablePrimitives.mockResolvedValue([
      { type: "scope", id: "expenses:read", label: "expenses:read" },
    ]);

    const response = await GET(new Request("https://weldall.example/api/directory/primitives"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual([
      { type: "scope", id: "expenses:read", label: "expenses:read" },
    ]);
    expect(mocks.listSearchablePrimitives).toHaveBeenCalledWith("user@example.com");
    expect(mocks.after).toHaveBeenCalledOnce();
  });
});
