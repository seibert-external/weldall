import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getVisibleSkill: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
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
vi.mock("../src/server/skills/service", () => ({
  getVisibleSkill: mocks.getVisibleSkill,
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
  });

  it("does not warn when all required scopes are granted", async () => {
    mocks.getVisibleSkill.mockResolvedValue({ ...skill, available: true, missingScopes: [] });

    const html = renderToStaticMarkup(
      await SkillPage({ params: Promise.resolve({ slug: skill.slug }) }),
    );

    expect(html).not.toContain("Missing required scopes");
  });
});
