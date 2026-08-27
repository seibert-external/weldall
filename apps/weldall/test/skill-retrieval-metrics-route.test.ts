import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getVisibleSkillRetrievalSummary: vi.fn(),
}));

vi.mock("../src/server/auth/auth.js", () => ({
  auth: {
    api: {
      getSession: mocks.getSession,
    },
  },
}));
vi.mock("../src/server/skills/service.js", () => ({
  SkillTemporarilyUnavailableError: class SkillTemporarilyUnavailableError extends Error {},
}));
vi.mock("../src/server/skills/retrieval-metrics.js", async () => {
  const actual = await vi.importActual<typeof import("../src/server/skills/retrieval-metrics.js")>(
    "../src/server/skills/retrieval-metrics.js",
  );
  return {
    ...actual,
    getVisibleSkillRetrievalSummary: mocks.getVisibleSkillRetrievalSummary,
  };
});

import { GET } from "../src/app/api/me/skills/[slug]/retrieval-metrics/route.js";

const requestUrl = "https://weldall.example.com/api/me/skills/expense-review/retrieval-metrics";
const session = { user: { email: "user@example.com" } };
const summary = {
  skillSlug: "expense-review",
  windowDays: 7,
  uniqueRetrievalCount: 2,
  uniqueRetrievers: [
    { id: "user-a", displayName: "Avery Analyst" },
    { id: "user-b", displayName: "Bea Builder" },
  ],
};

describe("skill retrieval metrics route", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getVisibleSkillRetrievalSummary.mockReset();
  });

  it("returns the default 7-day metric for authorized users", async () => {
    mocks.getSession.mockResolvedValue(session);
    mocks.getVisibleSkillRetrievalSummary.mockResolvedValue(summary);

    const response = await GET(new Request(requestUrl), {
      params: Promise.resolve({ slug: summary.skillSlug }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getVisibleSkillRetrievalSummary).toHaveBeenCalledWith(
      session.user.email,
      summary.skillSlug,
      7,
    );
    await expect(response.json()).resolves.toMatchObject({
      skillSlug: summary.skillSlug,
      windowDays: 7,
      uniqueRetrievalCount: 2,
      uniqueRetrievers: summary.uniqueRetrievers,
    });
  });

  it("accepts a bounded custom window", async () => {
    mocks.getSession.mockResolvedValue(session);
    mocks.getVisibleSkillRetrievalSummary.mockResolvedValue({
      ...summary,
      windowDays: 14,
    });

    const response = await GET(new Request(`${requestUrl}?days=14`), {
      params: Promise.resolve({ slug: summary.skillSlug }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getVisibleSkillRetrievalSummary).toHaveBeenCalledWith(
      session.user.email,
      summary.skillSlug,
      14,
    );
    await expect(response.json()).resolves.toMatchObject({
      windowDays: 14,
      uniqueRetrievers: summary.uniqueRetrievers,
    });
  });

  it("rejects invalid window sizes", async () => {
    mocks.getSession.mockResolvedValue(session);

    const response = await GET(new Request(`${requestUrl}?days=0`), {
      params: Promise.resolve({ slug: summary.skillSlug }),
    });

    expect(response.status).toBe(400);
    expect(mocks.getVisibleSkillRetrievalSummary).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_request",
    });
  });

  it("hides inaccessible skills and requires a session", async () => {
    mocks.getSession.mockResolvedValue(session);
    mocks.getVisibleSkillRetrievalSummary.mockResolvedValue(null);

    const hiddenResponse = await GET(new Request(requestUrl), {
      params: Promise.resolve({ slug: summary.skillSlug }),
    });
    expect(hiddenResponse.status).toBe(404);
    await expect(hiddenResponse.json()).resolves.toMatchObject({ error: "not_found" });

    mocks.getSession.mockResolvedValue(null);
    const unauthorized = await GET(new Request(requestUrl), {
      params: Promise.resolve({ slug: summary.skillSlug }),
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({ error: "Unauthorized" });
  });
});
