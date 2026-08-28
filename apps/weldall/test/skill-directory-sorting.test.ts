import { describe, expect, it } from "vitest";
import type { VisibleSkill } from "../src/server/skills/service";
import {
  DEFAULT_SKILL_DIRECTORY_SORT,
  SKILL_DIRECTORY_SORT_OPTIONS,
  isSkillDirectorySort,
  sortSkillsForDirectory,
} from "../src/app/_components/skill-directory-sorting";

function createSkill(overrides: Partial<VisibleSkill> & Pick<VisibleSkill, "slug">): VisibleSkill {
  return {
    title: overrides.slug,
    preview: "",
    requiredScopes: [],
    visibility: "DEFAULT",
    available: true,
    missingScopes: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "admin" },
    ...overrides,
  };
}

const skills = [
  createSkill({ slug: "zeta", title: "Zeta" }),
  createSkill({ slug: "alpha", title: "Alpha" }),
  createSkill({ slug: "locked", title: "A locked skill", available: false, missingScopes: ["x"] }),
];

const slugsIn = (sort: (typeof SKILL_DIRECTORY_SORT_OPTIONS)[number]["value"]) =>
  sortSkillsForDirectory(skills, sort, { alpha: 4, zeta: 4 }).map(({ slug }) => slug);

describe("skill directory sorting", () => {
  it("defaults to usage and keeps alphabetical order for equal counts", () => {
    expect(DEFAULT_SKILL_DIRECTORY_SORT).toBe("usage");
    expect(SKILL_DIRECTORY_SORT_OPTIONS[0]?.value).toBe(DEFAULT_SKILL_DIRECTORY_SORT);
    expect(slugsIn("usage")).toEqual(["alpha", "zeta", "locked"]);
  });

  it("orders unranked skills after the ones with retrievals", () => {
    const ranked = sortSkillsForDirectory(skills, "usage", { zeta: 2 }).map(({ slug }) => slug);
    expect(ranked[0]).toBe("zeta");
    expect(ranked.slice(1)).toEqual(["locked", "alpha"]);
  });

  it("sorts by the published date, falling back to the ingested date", () => {
    const dated = [
      createSkill({ slug: "old", title: "Old", updatedAt: "2026-02-01T00:00:00.000Z" }),
      createSkill({ slug: "fresh", title: "Fresh", lastUpdatedAt: "2026-03-01T00:00:00.000Z" }),
      createSkill({ slug: "middle", title: "Middle", lastUpdatedAt: "not a date" }),
    ];
    expect(
      sortSkillsForDirectory(dated, "updated", {}).map(({ slug }) => slug),
    ).toEqual(["fresh", "old", "middle"]);
  });

  it("lists available skills before locked ones when sorting by availability", () => {
    expect(slugsIn("available")).toEqual(["alpha", "zeta", "locked"]);
  });

  it("sorts by name regardless of usage", () => {
    expect(
      sortSkillsForDirectory(skills, "title", { locked: 99 }).map(({ slug }) => slug),
    ).toEqual(["locked", "alpha", "zeta"]);
  });

  it("does not mutate the incoming list", () => {
    const before = skills.map(({ slug }) => slug);
    sortSkillsForDirectory(skills, "usage", { locked: 1 });
    expect(skills.map(({ slug }) => slug)).toEqual(before);
  });

  it("recognizes only the offered sort keys", () => {
    expect(SKILL_DIRECTORY_SORT_OPTIONS.map(({ value }) => value)).toEqual([
      "usage",
      "updated",
      "title",
      "available",
    ]);
    expect(isSkillDirectorySort("usage")).toBe(true);
    expect(isSkillDirectorySort("recent")).toBe(false);
    expect(isSkillDirectorySort(undefined)).toBe(false);
  });
});
