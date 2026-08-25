import { describe, expect, it } from "vitest";
import { resolveSkillAppearance } from "../src/app/_components/skill-appearance";
import { lucideIconNames, resolveLucideIconNode } from "../src/server/skills/appearance-icons";

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
    expect(lucideIconNames).toHaveLength(1_997);
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
