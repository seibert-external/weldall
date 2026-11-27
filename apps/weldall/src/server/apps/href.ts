/* No imports: client components render links with it. */

/**
 * The value for an `href`: only an https URL, whatever is stored. Discovery stores nothing else;
 * this keeps a `javascript:` or `data:` URL out of a link even if a row says otherwise.
 */
export function httpsHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
