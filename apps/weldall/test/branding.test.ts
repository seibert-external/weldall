import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import Home from "../src/app/page";
import SkillsPage from "../src/app/skills/page";
import { getEffectiveCliLogoUrls, parseCliLogoUrl } from "../src/server/branding";

const pageMocks = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue(null),
  isAdminEmail: vi.fn().mockResolvedValue(false),
  listVisibleSkills: vi.fn().mockResolvedValue({ items: [], warnings: [] }),
  redirect: vi.fn(),
}));

vi.mock("../src/server/admin/service", () => ({ isAdminEmail: pageMocks.isAdminEmail }));
vi.mock("../src/server/auth/auth", () => ({
  auth: { api: { getSession: pageMocks.getSession } },
}));
vi.mock("../src/server/skills/service", () => ({
  listVisibleSkills: pageMocks.listVisibleSkills,
}));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: pageMocks.redirect,
  usePathname: vi.fn().mockReturnValue("/"),
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}));

let originalLogoUrls: { light: string; dark: string } | undefined;
afterEach(async () => {
  pageMocks.getSession.mockResolvedValue(null);
  pageMocks.isAdminEmail.mockResolvedValue(false);
  pageMocks.listVisibleSkills.mockResolvedValue({ items: [], warnings: [] });
  pageMocks.redirect.mockReset();
  if (originalLogoUrls) {
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: originalLogoUrls.light, darkLogoUrl: originalLogoUrls.dark },
    });
    originalLogoUrls = undefined;
  }
});

describe("CLI branding", () => {
  it("keeps unset or empty values empty and rejects unsafe URLs", async () => {
    expect(parseCliLogoUrl(undefined)).toBe("");
    expect(parseCliLogoUrl("  ")).toBe("");
    expect(() => parseCliLogoUrl("http://example.com/logo.svg")).toThrow(/HTTPS/);
    expect(() => parseCliLogoUrl("https://user:pass@example.com/logo.svg")).toThrow(/credentials/);

    const settings = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
    originalLogoUrls = { light: settings.logoUrl, dark: settings.darkLogoUrl };
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: "https://example.com/brand.svg", darkLogoUrl: "" },
    });
    await expect(getEffectiveCliLogoUrls()).resolves.toEqual({
      light: "https://example.com/brand.svg",
      dark: "https://example.com/brand.svg",
    });

    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: "", darkLogoUrl: "https://example.com/brand-dark.svg" },
    });
    await expect(getEffectiveCliLogoUrls()).resolves.toEqual({
      light: "https://example.com/brand-dark.svg",
      dark: "https://example.com/brand-dark.svg",
    });
  });

  it("renders the configured logo on the welcome page", async () => {
    const settings = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
    originalLogoUrls = { light: settings.logoUrl, dark: settings.darkLogoUrl };
    await db.cliSettings.update({
      where: { id: "default" },
      data: {
        logoUrl: "https://cdn.example.com/company-logo.svg",
        darkLogoUrl: "https://cdn.example.com/company-logo-dark.svg",
      },
    });

    const html = renderToStaticMarkup(await Home());

    expect(html).toContain(
      '<img src="https://cdn.example.com/company-logo.svg" alt="Configured company logo"',
    );
    expect(html).toContain(
      '<img src="https://cdn.example.com/company-logo-dark.svg" alt="Configured company logo"',
    );
    expect(html).toContain("theme-logo-light");
    expect(html).toContain("theme-logo-dark");
  });

  it("redirects signed-in users from the welcome page to skills", async () => {
    pageMocks.getSession.mockResolvedValue({
      user: { id: "regular-user", email: "user@example.com" },
    });

    await Home();

    expect(pageMocks.redirect).toHaveBeenCalledWith("/skills");
  });

  it("shows administration access to users with the administer scope", async () => {
    pageMocks.getSession.mockResolvedValue({
      user: { id: "admin-user", email: "admin@example.com" },
    });
    pageMocks.isAdminEmail.mockResolvedValue(true);

    const html = renderToStaticMarkup(createElement(NuqsTestingAdapter, null, await SkillsPage()));

    expect(pageMocks.isAdminEmail).toHaveBeenCalledWith("admin@example.com");
    expect(html).toContain('href="/admin/resources"');
    expect(html).toContain("Administration");
    expect(html).not.toContain("Your organization");
  });

  it("shows visible skills as locked when required scopes are missing", async () => {
    pageMocks.getSession.mockResolvedValue({
      user: { id: "regular-user", email: "user@example.com" },
    });
    pageMocks.listVisibleSkills.mockResolvedValue({
      items: [
        {
          slug: "demo.finance.expense-review",
          title: "Review employee expenses",
          preview: "Check expense submissions.",
          requiredScopes: ["expenses:read"],
          visibility: "DEFAULT",
          available: false,
          missingScopes: ["expenses:read"],
          updatedAt: "2026-06-01T00:00:00.000Z",
          source: { type: "admin" },
        },
      ],
      warnings: [],
    });

    const html = renderToStaticMarkup(createElement(NuqsTestingAdapter, null, await SkillsPage()));

    expect(html).toContain("Review employee expenses");
    expect(html).toContain('aria-label="Missing 1 scope"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('href="/skill/demo.finance.expense-review"');
  });

  it("renders a colored provider tag first for resource-discovered skills", async () => {
    pageMocks.getSession.mockResolvedValue({
      user: { id: "regular-user", email: "user@example.com" },
    });
    pageMocks.listVisibleSkills.mockResolvedValue({
      items: [
        {
          slug: "contracts.contract-review",
          title: "Review a contract",
          preview: "Review contract terms.",
          requiredScopes: ["contracts:read"],
          visibility: "DEFAULT",
          available: true,
          missingScopes: [],
          updatedAt: "2026-06-01T00:00:00.000Z",
          source: { type: "resource", key: "contracts", name: "Contract Service" },
          meta: { tags: ["contracts", "review"] },
        },
        {
          slug: "expenses.expense-review",
          title: "Review an expense",
          preview: "Review expense details.",
          requiredScopes: ["expenses:read"],
          visibility: "DEFAULT",
          available: true,
          missingScopes: [],
          updatedAt: "2026-06-01T00:00:00.000Z",
          source: { type: "resource", key: "expenses", name: "Expense Service" },
          meta: { tags: ["expenses", "review"] },
        },
      ],
      warnings: [],
    });

    const html = renderToStaticMarkup(
      createElement(
        NuqsTestingAdapter,
        { searchParams: "?resource=contracts" },
        await SkillsPage(),
      ),
    );
    const cardTagsIndex = html.indexOf('class="skill-card-tags"');
    const resourceTagIndex = html.indexOf("contract-service", cardTagsIndex);
    const regularTagIndex = html.indexOf(">contracts</span>", resourceTagIndex);

    expect(cardTagsIndex).toBeGreaterThan(-1);
    expect(resourceTagIndex).toBeGreaterThan(cardTagsIndex);
    expect(html).toContain('class="skill-card-resource-tag"');
    expect(html).not.toContain("⚡️");
    expect(regularTagIndex).toBeGreaterThan(resourceTagIndex);
    expect(html).not.toContain("Review an expense");
  });

  it("renders no company logo when none is configured", async () => {
    const settings = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
    originalLogoUrls = { light: settings.logoUrl, dark: settings.darkLogoUrl };
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: "", darkLogoUrl: "" },
    });

    const html = renderToStaticMarkup(await Home());

    expect(html).not.toContain("Configured company logo");
    expect(html).not.toContain("public-brand-x");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("Copy Prompt");
  });
});
