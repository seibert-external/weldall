import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSkillRetrievalSummaryBySlug: vi.fn(),
  getVisibleSkill: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
  SkillRetrievalSummarySection: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
  usePathname: vi.fn().mockReturnValue("/skill/expense-review"),
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("../src/server/admin/service", () => ({
  isAdminEmail: vi.fn().mockResolvedValue(false),
}));
vi.mock("../src/server/auth/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue({ user: { email: "user@example.com" } }),
    },
  },
}));
vi.mock("../src/server/branding", () => ({
  getEffectiveCliLogoUrls: vi.fn().mockResolvedValue({ light: "", dark: "" }),
}));
vi.mock("../src/server/skills/catalogs", () => ({ refreshDueCatalogs: vi.fn() }));
vi.mock("../src/server/skills/retrieval-metrics", () => ({
  getSkillRetrievalSummaryBySlug: mocks.getSkillRetrievalSummaryBySlug,
}));
vi.mock("../src/server/skills/service", () => ({
  getVisibleSkill: mocks.getVisibleSkill,
}));
vi.mock("../src/app/_components/skill-retrieval-summary", () => ({
  SkillRetrievalSummarySection: mocks.SkillRetrievalSummarySection,
}));

import SkillPage from "../src/app/skill/[slug]/page";

const skill = {
  slug: "expense-review",
  title: "Review expenses",
  content: "Review submitted expenses.",
  document: "Review submitted expenses.",
  requiredScopes: ["expenses:read", "expenses:approve"],
  visibility: "DEFAULT" as const,
  available: false,
  missingScopes: ["expenses:approve"],
  updatedAt: "2026-06-01T00:00:00.000Z",
  source: { type: "admin" as const },
  involvedResources: [],
};

describe("skill detail availability", () => {
  beforeEach(() => {
    mocks.getSkillRetrievalSummaryBySlug.mockReset().mockResolvedValue({
      skillSlug: skill.slug,
      windowDays: 7,
      uniqueRetrievalCount: 5,
      uniqueRetrievers: [
        { id: "user-a", displayName: "Avery Analyst" },
        { id: "user-b", displayName: "Bea Builder" },
      ],
    });
    mocks.SkillRetrievalSummarySection.mockReset().mockImplementation(({ initialSummary }) =>
      createElement(
        "section",
        null,
        createElement("h2", null, "Retrievals"),
        createElement(
          "p",
          { className: "skill-detail-muted" },
          initialSummary
            ? `${initialSummary.uniqueRetrievalCount} unique retrievals in the last ${initialSummary.windowDays} days`
            : "Loading retrievals…",
        ),
      ),
    );
    mocks.getVisibleSkill.mockReset().mockResolvedValue(skill);
    mocks.notFound.mockReset();
    mocks.redirect.mockReset();
  });

  it("warns when the signed-in user lacks required scopes", async () => {
    const html = renderToStaticMarkup(
      await SkillPage({ params: Promise.resolve({ slug: skill.slug }) }),
    );

    expect(html).toContain("Missing required scopes");
    expect(html).toContain(
      "Your account is missing the following required scopes: expenses:approve.",
    );
    expect(html).toContain("5 unique retrievals in the last 7 days");
    expect(mocks.getSkillRetrievalSummaryBySlug).toHaveBeenCalledWith(skill.slug);
    expect(mocks.SkillRetrievalSummarySection).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: skill.slug,
        initialSummary: expect.objectContaining({
          skillSlug: skill.slug,
          uniqueRetrievalCount: 5,
          windowDays: 7,
        }),
      }),
      undefined,
    );
  });

  it("does not warn when all required scopes are granted", async () => {
    mocks.getVisibleSkill.mockResolvedValue({ ...skill, available: true, missingScopes: [] });

    const html = renderToStaticMarkup(
      await SkillPage({ params: Promise.resolve({ slug: skill.slug }) }),
    );

    expect(html).not.toContain("Missing required scopes");
  });
});
