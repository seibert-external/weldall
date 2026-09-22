import { encode } from "@toon-format/toon";
import type { CachedSkillPreview } from "./storage/appendix.js";
import type { SkillDetail, SkillList, SkillSummary, SkillWarning } from "./services/skills.js";
import { TOON_OPTIONS, joined } from "./toon.js";

// The resource key is already the slug's prefix, so the column carries the name a person reads.
const sourceOf = (skill: SkillSummary) =>
  skill.source.type === "resource" ? skill.source.name : "admin";

const itemRow = (skill: SkillSummary) => ({
  slug: skill.slug,
  title: skill.title,
  preview: skill.preview,
  tags: joined(skill.meta?.tags),
  available: skill.available,
  missingScopes: joined(skill.missingScopes),
  source: sourceOf(skill),
});

const warningRow = (warning: SkillWarning) => ({ source: warning.source, code: warning.code });

// The cache behind `skills find` never holds missingScopes, and an empty column there would read
// as "nothing is missing", which is the one thing the cache cannot promise.
const matchRow = (skill: CachedSkillPreview) => ({
  slug: skill.slug,
  title: skill.title,
  preview: skill.preview ?? "",
  tags: joined(skill.tags),
  available: skill.available,
  owner: skill.owner ?? "",
  source: skill.sourceName ?? skill.sourceKey ?? "",
});

export function skillsToon(list: SkillList): string {
  return encode(
    { items: list.items.map(itemRow), warnings: list.warnings.map(warningRow) },
    TOON_OPTIONS,
  ).concat("\n");
}

// One skill is an object, not an array of one, so it is encoded as TOON objects are: a line per
// field. `content` is left out because the document already contains it, and `preview` because
// the document supersedes it. Both would otherwise ship the skill body two or three times over,
// which is what makes the `--json` shape of this command roughly twice the size.
export function skillDetailToon(skill: SkillDetail): string {
  return encode(
    {
      slug: skill.slug,
      title: skill.title,
      tags: skill.meta?.tags ?? [],
      available: skill.available,
      missingScopes: skill.missingScopes,
      source: sourceOf(skill),
      document: skill.document,
    },
    TOON_OPTIONS,
  ).concat("\n");
}

export function skillMatchesToon(matches: readonly CachedSkillPreview[]): string {
  return encode({ items: matches.map(matchRow) }, TOON_OPTIONS).concat("\n");
}
