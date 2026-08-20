import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import Home from "../src/app/page";
import { getEffectiveCliLogoUrls, parseCliLogoUrl } from "../src/server/branding";

const pageMocks = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue(null),
  isAdminEmail: vi.fn().mockResolvedValue(false),
  listVisibleSkills: vi.fn().mockResolvedValue({ items: [], warnings: [] }),
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

let originalLogoUrls: { light: string; dark: string } | undefined;
afterEach(async () => {
  pageMocks.getSession.mockResolvedValue(null);
  pageMocks.isAdminEmail.mockResolvedValue(false);
  pageMocks.listVisibleSkills.mockResolvedValue({ items: [], warnings: [] });
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

  it("shows administration access to users with the administer scope", async () => {
    pageMocks.getSession.mockResolvedValue({
      user: { id: "admin-user", email: "admin@example.com" },
    });
    pageMocks.isAdminEmail.mockResolvedValue(true);

    const html = renderToStaticMarkup(await Home());

    expect(pageMocks.isAdminEmail).toHaveBeenCalledWith("admin@example.com");
    expect(html).toContain('href="/resources"');
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

    const html = renderToStaticMarkup(await Home());

    expect(html).toContain("Review employee expenses");
    expect(html).toContain('aria-label="Missing 1 scope"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('href="/skill/demo.finance.expense-review"');
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
