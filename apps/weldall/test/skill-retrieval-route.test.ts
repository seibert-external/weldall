import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  authenticateCliApiRequest: vi.fn(),
  getVisibleSkill: vi.fn(),
  loggedOauthErrorResponse: vi.fn(),
  recordSkillRetrievalEvent: vi.fn(),
  refreshDueCatalogs: vi.fn(),
  warn: vi.fn(),
  errorForLog: vi.fn((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) })),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("../src/server/oauth/cli-api.js", () => ({
  authenticateCliApiRequest: mocks.authenticateCliApiRequest,
}));
vi.mock("../src/server/oauth/error-response.js", () => ({
  loggedOauthErrorResponse: mocks.loggedOauthErrorResponse,
}));
vi.mock("../src/server/observability/http.js", () => ({
  withRequestLogging: (_route: string, handler: any) => handler,
}));
vi.mock("../src/server/observability/logger.js", () => ({
  errorForLog: mocks.errorForLog,
  logger: { warn: mocks.warn },
}));
vi.mock("../src/server/skills/catalogs.js", () => ({
  refreshDueCatalogs: mocks.refreshDueCatalogs,
}));
vi.mock("../src/server/skills/retrieval-metrics.js", () => ({
  recordSkillRetrievalEvent: mocks.recordSkillRetrievalEvent,
}));
vi.mock("../src/server/skills/service.js", () => ({
  getVisibleSkill: mocks.getVisibleSkill,
  SkillTemporarilyUnavailableError: class SkillTemporarilyUnavailableError extends Error {},
}));

import { GET } from "../src/app/api/me/skills/[slug]/route.js";

const requestUrl = "https://weldall.example.com/api/me/skills/expense-review";
const skill = {
  slug: "expense-review",
  title: "Review expenses",
  content: "Review submitted expenses.",
  document: "Review submitted expenses.",
  requiredScopes: [],
  visibility: "DEFAULT" as const,
  available: true,
  missingScopes: [],
  updatedAt: "2026-06-01T00:00:00.000Z",
  source: { type: "admin" as const },
  involvedResources: [],
};
const user = {
  id: "skill-retrieval-user",
  email: "user@example.com",
  name: "  Avery Analyst  ",
};

describe("skill retrieval route", () => {
  it("records one event for a successful authenticated retrieval", async () => {
    mocks.authenticateCliApiRequest.mockReset().mockResolvedValue(user);
    mocks.getVisibleSkill.mockReset().mockResolvedValue(skill);
    mocks.recordSkillRetrievalEvent.mockReset().mockResolvedValue(undefined);
    mocks.loggedOauthErrorResponse.mockReset();
    mocks.warn.mockReset();

    const response = await GET(new Request(requestUrl), {
      params: Promise.resolve({ slug: skill.slug }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(skill);
    expect(mocks.recordSkillRetrievalEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordSkillRetrievalEvent).toHaveBeenCalledWith({
      skillSlug: skill.slug,
      retrieverId: user.id,
      retrieverName: "Avery Analyst",
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not record denied or not-found retrievals", async () => {
    mocks.authenticateCliApiRequest.mockReset().mockResolvedValue(user);
    mocks.getVisibleSkill.mockReset().mockResolvedValueOnce(null);
    mocks.recordSkillRetrievalEvent.mockReset().mockResolvedValue(undefined);
    mocks.loggedOauthErrorResponse.mockReset();
    mocks.warn.mockReset();

    const response = await GET(new Request(requestUrl), {
      params: Promise.resolve({ slug: skill.slug }),
    });

    expect(response.status).toBe(404);
    expect(mocks.recordSkillRetrievalEvent).not.toHaveBeenCalled();
  });

  it("does not record failed authentications", async () => {
    const authError = new Error("authorization failed");
    mocks.authenticateCliApiRequest.mockReset().mockRejectedValue(authError);
    mocks.recordSkillRetrievalEvent.mockReset().mockResolvedValue(undefined);
    const authResponse = Response.json({ error: "auth_failed" }, { status: 401 });
    mocks.loggedOauthErrorResponse.mockReset().mockReturnValue(authResponse);
    mocks.getVisibleSkill.mockReset();
    mocks.warn.mockReset();

    const response = await GET(new Request(requestUrl), {
      params: Promise.resolve({ slug: skill.slug }),
    });

    expect(response.status).toBe(401);
    expect(mocks.recordSkillRetrievalEvent).not.toHaveBeenCalled();
    expect(mocks.loggedOauthErrorResponse).toHaveBeenCalledWith(authError);
  });
});
