import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import Home from "../src/app/page";
import { getEffectiveCliLogoUrl, parseCliLogoUrl } from "../src/server/branding";

let originalLogoUrl: string | undefined;
afterEach(async () => {
  if (originalLogoUrl !== undefined) {
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: originalLogoUrl },
    });
    originalLogoUrl = undefined;
  }
});

describe("CLI branding", () => {
  it("keeps unset or empty values empty and rejects unsafe URLs", async () => {
    expect(parseCliLogoUrl(undefined)).toBe("");
    expect(parseCliLogoUrl("  ")).toBe("");
    expect(() => parseCliLogoUrl("http://example.com/logo.svg")).toThrow(/HTTPS/);
    expect(() => parseCliLogoUrl("https://user:pass@example.com/logo.svg")).toThrow(/credentials/);

    const settings = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
    originalLogoUrl = settings.logoUrl;
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: "https://example.com/brand.svg" },
    });
    await expect(getEffectiveCliLogoUrl()).resolves.toBe("https://example.com/brand.svg");
  });

  it("renders the configured logo on the welcome page", async () => {
    const settings = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
    originalLogoUrl = settings.logoUrl;
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: "https://cdn.example.com/company-logo.svg" },
    });

    const html = renderToStaticMarkup(await Home());

    expect(html).toContain(
      '<img src="https://cdn.example.com/company-logo.svg" alt="Configured company logo"',
    );
  });

  it("renders no company logo when none is configured", async () => {
    const settings = await db.cliSettings.findUniqueOrThrow({ where: { id: "default" } });
    originalLogoUrl = settings.logoUrl;
    await db.cliSettings.update({
      where: { id: "default" },
      data: { logoUrl: "" },
    });

    const html = renderToStaticMarkup(await Home());

    expect(html).not.toContain("Configured company logo");
    expect(html).not.toContain("welcome-brand-x");
  });
});
