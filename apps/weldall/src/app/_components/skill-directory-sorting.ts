import type { VisibleSkill } from "@/server/skills/service";

/**
 * Sorts offered by the skills directory. "usage" is the default because the flame badge next to
 * every skill title is the primary signal for what the organization actually pulls.
 */
export const SKILL_DIRECTORY_SORTS = ["usage", "updated", "title", "available"] as const;

export type SkillDirectorySort = (typeof SKILL_DIRECTORY_SORTS)[number];

export const DEFAULT_SKILL_DIRECTORY_SORT: SkillDirectorySort = "usage";

export const SKILL_DIRECTORY_SORT_OPTIONS = [
  { value: "usage", label: "Most used" },
  { value: "updated", label: "Recently updated" },
  { value: "title", label: "Name (A–Z)" },
  { value: "available", label: "Available first" },
] as const satisfies ReadonlyArray<{ value: SkillDirectorySort; label: string }>;

export function isSkillDirectorySort(value: unknown): value is SkillDirectorySort {
  return (
    typeof value === "string" &&
    SKILL_DIRECTORY_SORT_OPTIONS.some((option) => option.value === value)
  );
}

/**
 * Orders skills for the directory. Every comparator falls back to the alphabetical order the
 * catalog already guarantees, so equal ranks stay stable across refreshes and pages.
 */
export function sortSkillsForDirectory<T extends VisibleSkill>(
  skills: readonly T[],
  sort: SkillDirectorySort,
  retrievalCounts: Readonly<Record<string, number>>,
): T[] {
  const ranked = [...skills];
  if (sort === "usage") {
    return ranked.sort(
      (left, right) =>
        (retrievalCounts[right.slug] ?? 0) - (retrievalCounts[left.slug] ?? 0) ||
        compareByTitleThenSlug(left, right),
    );
  }
  if (sort === "updated") {
    return ranked.sort(
      (left, right) =>
        skillUpdatedTime(right) - skillUpdatedTime(left) || compareByTitleThenSlug(left, right),
    );
  }
  if (sort === "available") {
    return ranked.sort(
      (left, right) =>
        Number(right.available) - Number(left.available) || compareByTitleThenSlug(left, right),
    );
  }
  return ranked.sort(compareByTitleThenSlug);
}

function compareByTitleThenSlug(left: VisibleSkill, right: VisibleSkill): number {
  return left.title.localeCompare(right.title) || left.slug.localeCompare(right.slug);
}

/**
 * Publisher-declared content date when the catalog provides one, otherwise the moment Weldall
 * last ingested the skill. Unparseable dates sort last.
 */
function skillUpdatedTime(skill: VisibleSkill): number {
  const timestamp = Date.parse(skill.lastUpdatedAt ?? skill.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
