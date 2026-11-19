const MAX_APP_LINK_LENGTH = 2_000;

/**
 * The URL in canonical form when it is an https URL without credentials, else null. Links in the
 * registry (repository, preview, live) are reported by a Git app and shown to people and agents,
 * so anything else is dropped rather than passed on.
 */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_APP_LINK_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return url.href.length > MAX_APP_LINK_LENGTH ? null : url.href;
  } catch {
    return null;
  }
}
