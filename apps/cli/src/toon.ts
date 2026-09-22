import type { EncodeOptions } from "@toon-format/toon";

// Token-Oriented Object Notation, produced by the format's reference encoder. Arrays declare
// their length and field names once, objects are plain `key: value` lines, and strings are
// quoted only where a bare value would be ambiguous. The declared count is the reason this
// output exists. An agent that reads a truncated payload can see that it did, which bare JSON
// never tells it.
//
// Tab is the delimiter because skill previews and resource names contain commas, which is TOON's
// default delimiter.
export const TOON_OPTIONS: EncodeOptions = { delimiter: "\t" };

// A nested array cannot be a cell of its own, so a row carries its list in one column.
export const joined = (values: readonly string[] | undefined) => (values ?? []).join("|");
