/**
 * Text that comes from a folder, a remote or a Git app (URLs, config keys, names), shown bounded
 * and without control or non-ASCII characters.
 */
export const printable = (text: string, maxLength = 300) =>
  text.replace(/[^\x20-\x7e]/g, "?").slice(0, maxLength);
