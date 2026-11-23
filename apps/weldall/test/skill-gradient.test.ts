import { describe, expect, it } from "vitest";
import {
  brandGradient,
  contrastRatio,
  gradientFromColor,
  iconColorFor,
  isHexColor,
  needsDarkRing,
  relativeLuminance,
  SKILL_COLOR_SWATCHES,
  SKILL_ICON_DARK,
  SKILL_ICON_LIGHT,
} from "../src/app/_components/skill-gradient";

const allColors = (gradient: { light: readonly string[]; dark: readonly string[] }) => [
  ...gradient.light,
  ...gradient.dark,
];

describe("skill gradient", () => {
  it("keeps the brand colour unchanged and fades into a darker shade", () => {
    const jira = brandGradient("#0052CC");

    expect(jira.light[0]).toBe("#0052cc");
    expect(jira.dark).toEqual(jira.light);
    expect(relativeLuminance(jira.light[1])).toBeLessThan(relativeLuminance(jira.light[0]));
  });

  it("uses a white icon from 3:1 contrast and a dark icon below", () => {
    expect(iconColorFor(brandGradient("#0052cc").light)).toBe(SKILL_ICON_LIGHT);
    expect(iconColorFor(brandGradient("#ea4335").light)).toBe(SKILL_ICON_LIGHT);
    expect(iconColorFor(brandGradient("#ff7a59").light)).toBe(SKILL_ICON_DARK);
    expect(iconColorFor(brandGradient("#ecd53f").light)).toBe(SKILL_ICON_DARK);
  });

  it("keeps a readable white icon on gradients computed from a picked colour", () => {
    for (const color of ["#ffe033", "#5730cc", "#000000", "#ffffff", "#28ac9b"]) {
      const gradient = gradientFromColor(color);
      expect(allColors(gradient).every(isHexColor)).toBe(true);
      expect(contrastRatio(SKILL_ICON_LIGHT, gradient.light[0])).toBeGreaterThanOrEqual(3);
    }
  });

  it("never lets a computed dark gradient sink into a dark page", () => {
    const gradient = gradientFromColor("#000000");

    expect(needsDarkRing(gradient.dark)).toBe(false);
    expect(needsDarkRing(brandGradient("#000000").dark)).toBe(true);
  });

  it("offers single-colour swatches across the colour wheel with readable gradients", () => {
    expect(SKILL_COLOR_SWATCHES).toHaveLength(13);
    expect(new Set(SKILL_COLOR_SWATCHES.map(({ color }) => color)).size).toBe(13);
    for (const swatch of SKILL_COLOR_SWATCHES) {
      expect(isHexColor(swatch.color)).toBe(true);
      const gradient = gradientFromColor(swatch.color);
      expect(allColors(gradient).every(isHexColor)).toBe(true);
      expect(contrastRatio(SKILL_ICON_LIGHT, gradient.light[0])).toBeGreaterThanOrEqual(3);
    }
  });
});
