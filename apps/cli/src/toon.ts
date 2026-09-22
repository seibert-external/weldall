// Token-Oriented Object Notation, the subset this CLI emits: arrays declare their length and
// field names once, objects are plain `key: value` lines, and strings are quoted only where a
// bare value would be ambiguous. The declared count is the reason this output exists. An agent
// that reads a truncated payload can see that it did, which bare JSON never tells it.
//
// Tab is the delimiter because skill previews contain commas. TOON declares a non-default
// delimiter inside the bracket segment, so the tab sits between the length and the closing
// bracket and separates the field names too.
export const TAB = "\t";

const escape = (value: string) =>
  value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\t/gu, "\\t")
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n");

// Quote only where the value would otherwise forge a column, a row, or an empty field.
export const cell = (value: string) =>
  value === "" || value !== value.trim() || /[\t\n\r"\\]/u.test(value)
    ? `"${escape(value)}"`
    : value;

// An encoder must emit `key: []` for an empty array; the `key[0]:` header form is decode-only.
export const block = (name: string, fields: readonly string[], rows: readonly string[]) =>
  rows.length === 0
    ? `${name}: []`
    : [
        `${name}[${rows.length}${TAB}]{${fields.join(TAB)}}:`,
        ...rows.map((row) => `  ${row}`),
      ].join("\n");

export const inlineArray = (name: string, values: readonly string[]) =>
  values.length === 0
    ? `${name}: []`
    : `${name}[${values.length}${TAB}]: ${values.map(cell).join(TAB)}`;

export const field = (name: string, value: string) => `${name}: ${cell(value)}`;

export const row = (cells: readonly string[]) => cells.map(cell).join(TAB);

// A nested array cannot be a cell of its own, so a row carries its list in one column.
export const joined = (values: readonly string[] | undefined) => (values ?? []).join("|");
