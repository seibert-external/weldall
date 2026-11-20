/**
 * Text that comes from a folder, a remote or a Git app (URLs, config keys, names), shown bounded.
 * Control, format (bidirectional overrides, zero-width), line-separator, private-use, surrogate and
 * unassigned characters become `?`; letters and symbols of any script, umlauts included, stay.
 */
export const printable = (text: string, maxLength = 300) =>
  text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}]/gu, "?").slice(0, maxLength);
