import type { SkillList, SkillSummary, SkillWarning } from "./services/skills.js";

// Token-Oriented Object Notation, tabular subset: a header declaring the row count and the field
// names, then one row per item. The declared count is the reason this output exists. An agent that
// reads a truncated catalog can see that it did, which a bare JSON array never tells it.
//
// Tab is the delimiter because previews contain commas. TOON declares a non-default delimiter
// inside the bracket segment, so the tab sits between the length and the closing bracket and
// separates the field names too.
const TAB = "\t";
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

const escape = (value: string) =>
  value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\t/gu, "\\t")
    .replace(/\r?\n/gu, "\\n");

// Quote only where the value would otherwise forge a column, a row, or an empty field.
const cell = (value: string) =>
  value === "" || value !== value.trim() || /[\t\n\r"\\]/u.test(value)
    ? `"${escape(value)}"`
    : value;

// The resource key is already the slug's prefix, so the column carries the name a person reads.
const sourceOf = (skill: SkillSummary) =>
  skill.source.type === "resource" ? skill.source.name : "admin";

const itemRow = (skill: SkillSummary) =>
  [
    skill.slug,
    skill.title,
    skill.preview,
    (skill.meta?.tags ?? []).join("|"),
    String(skill.available),
    skill.missingScopes.join("|"),
    sourceOf(skill),
  ]
    .map(cell)
    .join(TAB);

const warningRow = (warning: SkillWarning) => [warning.source, warning.code].map(cell).join(TAB);

// An encoder must emit `key: []` for an empty array; the `key[0]:` header form is decode-only.
const block = (name: string, fields: readonly string[], rows: string[]) =>
  rows.length === 0
    ? `${name}: []`
    : [
        `${name}[${rows.length}${TAB}]{${fields.join(TAB)}}:`,
        ...rows.map((row) => `  ${row}`),
      ].join("\n");

export function skillsToon(list: SkillList): string {
  return [
    block("items", ITEM_FIELDS, list.items.map(itemRow)),
    block("warnings", WARNING_FIELDS, list.warnings.map(warningRow)),
  ]
    .join("\n")
    .concat("\n");
}
