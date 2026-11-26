import { describe, expect, it } from "vitest";
import { resolveSkillAppearance } from "../src/app/_components/skill-appearance";
import { appearanceValuesFrom, skillMetaFromForm } from "../src/app/admin/skills/skill-meta";
import {
  lucideIconNames,
  lucideIconTags,
  resolveLucideIconNode,
} from "../src/server/skills/appearance-icons";
import { brandIconOptions, resolveBrandIcon } from "../src/server/skills/brand-icons";

describe("skill appearance form", () => {
  it("saves an opened skill with unchanged appearance values exactly as stored", () => {
    const stored = {
      icon: "file-text",
      gradientFrom: "#ABCDEF",
      gradientTo: "#123456",
      darkGradientFrom: "#0F0F0F",
      darkGradientTo: "not-a-color",
      futureKey: "kept",
    };

    const meta = skillMetaFromForm("finance", "", appearanceValuesFrom(stored), stored);

    expect(meta).toEqual({ tags: ["finance"], appearance: stored });
  });

  it("stores a brand next to the existing icon and drops it when cleared", () => {
    const stored = { icon: "file-text", brandIcon: "hubspot" };
    const values = appearanceValuesFrom(stored);

    expect(skillMetaFromForm("", "", values, stored)?.appearance).toEqual(stored);
    expect(skillMetaFromForm("", "", { ...values, brandIcon: "" }, stored)?.appearance).toEqual({
      icon: "file-text",
    });
  });
});

describe("brand and icon catalogs", () => {
  it("resolves Simple Icons brands with their colour and path", () => {
    expect(brandIconOptions.length).toBeGreaterThan(3_000);
    expect(resolveBrandIcon("hubspot")).toMatchObject({ title: "HubSpot", hex: "#ff7a59" });
    expect(resolveBrandIcon("hubspot")?.path).toMatch(/^M/u);
    expect(resolveBrandIcon("not-a-brand")).toBeUndefined();
    expect(resolveBrandIcon(undefined)).toBeUndefined();
  });

  it("has search tags for Lucide icons from the same Lucide version", () => {
    expect(lucideIconTags["mail"]).toContain("email");
    expect(Object.keys(lucideIconTags).every((name) => lucideIconNames.includes(name))).toBe(true);
  });
});

describe("skill appearance", () => {
  it("uses complete light and dark gradients", () => {
    const appearance = resolveSkillAppearance("expenses.review", {
      icon: "file-text",
      gradientFrom: "#555BD6",
      gradientTo: "#7773E5",
      darkGradientFrom: "#2A2660",
      darkGradientTo: "#403A86",
      futureKey: "preserved",
    });

    expect(appearance.light).toEqual(["#555BD6", "#7773E5"]);
    expect(appearance.dark).toEqual(["#2A2660", "#403A86"]);
  });

  it("falls back per gradient pair when appearance is partial", () => {
    const fallback = resolveSkillAppearance("expenses.review");
    const appearance = resolveSkillAppearance("expenses.review", {
      gradientFrom: "#555BD6",
      darkGradientFrom: "#2A2660",
      darkGradientTo: "#403A86",
    });

    expect(appearance.light).toEqual(fallback.light);
    expect(appearance.dark).toEqual(["#2A2660", "#403A86"]);
  });

  it("falls back safely for unknown icons and invalid colors", () => {
    const fallback = resolveSkillAppearance("expenses.review");
    const appearance = resolveSkillAppearance("expenses.review", {
      icon: "not-a-lucide-icon",
      gradientFrom: "red",
      gradientTo: "#7773E5",
      darkGradientFrom: "#123",
      darkGradientTo: "#403A86",
    });

    expect(appearance.fallbackIconNode).toBe(fallback.fallbackIconNode);
    expect(appearance.light).toEqual(fallback.light);
    expect(appearance.dark).toEqual(fallback.dark);
  });

  it("resolves the full pinned Lucide catalog on the server and ignores unknown names", async () => {
    expect(lucideIconNames).toHaveLength(2_035);
    expect(lucideIconNames.every((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))).toBe(true);
    await expect(resolveLucideIconNode("file-text")).resolves.toEqual(expect.any(Array));
    await expect(resolveLucideIconNode("not-a-lucide-icon")).resolves.toBeUndefined();
  });

  it("keeps missing appearance deterministic by slug and tag", () => {
    expect(resolveSkillAppearance("expenses.review").fallbackIconNode[0]?.[1].d).toMatch(/^M6 22/);
    expect(resolveSkillAppearance("finance").fallbackIconNode[0]?.[1].d).toMatch(/^M3 3/);
    expect(resolveSkillAppearance("all-skills").fallbackIconNode[0]).toMatchObject([
      "circle",
      { cx: "12", cy: "12" },
    ]);
    expect(resolveSkillAppearance("überblick").fallbackIconNode[0]?.[1].d).toMatch(/^M16 21/);
  });
});
