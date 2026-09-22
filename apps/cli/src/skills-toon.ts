import type { CachedSkillPreview } from "./storage/appendix.js";
import type { SkillDetail, SkillList, SkillSummary, SkillWarning } from "./services/skills.js";
import { block, field, inlineArray, joined, row } from "./toon.js";

const ITEM_FIELDS = [
  "slug",
  "title",
  "preview",
  "tags",
  "available",
  "missingScopes",
  "source",
] as const;
const WARNING_FIELDS = ["source", "code"] as const;
// The cache behind `skills find` never holds missingScopes, and an empty column there would read
// as "nothing is missing", which is the one thing the cache cannot promise.
const MATCH_FIELDS = ["slug", "title", "preview", "tags", "available", "owner", "source"] as const;

// The resource key is already the slug's prefix, so the column carries the name a person reads.
const sourceOf = (skill: SkillSummary) =>
  skill.source.type === "resource" ? skill.source.name : "admin";

const itemRow = (skill: SkillSummary) =>
  row([
    skill.slug,
    skill.title,
    skill.preview,
    joined(skill.meta?.tags),
    String(skill.available),
    joined(skill.missingScopes),
    sourceOf(skill),
  ]);

const warningRow = (warning: SkillWarning) => row([warning.source, warning.code]);

const matchRow = (skill: CachedSkillPreview) =>
  row([
    skill.slug,
    skill.title,
    skill.preview ?? "",
    joined(skill.tags),
    String(skill.available),
    skill.owner ?? "",
    skill.sourceName ?? skill.sourceKey ?? "",
  ]);

export function skillsToon(list: SkillList): string {
  return [
    block("items", ITEM_FIELDS, list.items.map(itemRow)),
    block("warnings", WARNING_FIELDS, list.warnings.map(warningRow)),
  ]
    .join("\n")
    .concat("\n");
}

// One skill is an object, not an array of one, so it is encoded as TOON objects are: a line per
// field. `content` is left out because the document already contains it, and `preview` because
// the document supersedes it. Both would otherwise ship the skill body two or three times over,
// which is what makes the `--json` shape of this command roughly twice the size.
export function skillDetailToon(skill: SkillDetail): string {
  return [
    field("slug", skill.slug),
    field("title", skill.title),
    inlineArray("tags", skill.meta?.tags ?? []),
    field("available", String(skill.available)),
    inlineArray("missingScopes", skill.missingScopes),
    field("source", sourceOf(skill)),
    field("document", skill.document),
  ]
    .join("\n")
    .concat("\n");
}

export function skillMatchesToon(matches: readonly CachedSkillPreview[]): string {
  return block("items", MATCH_FIELDS, matches.map(matchRow)).concat("\n");
}
