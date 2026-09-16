const MAX_AVATAR_URL_LENGTH = 2_048;

/**
 * Accepts only an absolute HTTPS URL of bounded length without credentials or a fragment.
 * The group provider contract reports avatars as `avatar_url`; anything this function rejects is
 * not an avatar Weldall can serve, so callers treat it as absent instead of failing a lookup.
 */
export function parseAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_AVATAR_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  return url.toString();
}
