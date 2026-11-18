import { redactCredentials } from "./redaction.js";

export const TRUNCATION_MARKER = "…[truncated]";

/** Cuts `value` to at most `maximum` characters, ending in {@link TRUNCATION_MARKER} when cut. */
export function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let kept = value.slice(0, Math.max(0, maximum - TRUNCATION_MARKER.length));
  // Do not leave half of a surrogate pair before the marker.
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}${TRUNCATION_MARKER}`;
}

/**
 * Sanitising for text and links that come from the customer's Git host (review texts, check
 * names, logins, CI links) and are handed to an AI agent on the person's device. They are
 * returned as plain data fields, never merged into instructions; this module only makes them
 * bounded, credential-free and free of control characters.
 */

/** C0/C1 controls except tab and newline, plus Unicode format characters that reorder or hide text. */
const hiddenOrControl =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/** Removes control characters (except tab and newline) and invisible formatting characters. */
export const withoutHiddenCharacters = (value: string) => value.replace(hiddenOrControl, "");

/**
 * Redacts credentials, removes control and invisible formatting characters and cuts the text to
 * `maximum` characters. `multiline` keeps line breaks (review texts); otherwise every run of
 * whitespace becomes one space (names).
 */
export function untrustedGitText(
  value: string,
  maximum: number,
  { multiline = false }: { multiline?: boolean } = {},
): string {
  // Hidden characters go first so they cannot split a token past redaction; line breaks stay
  // until after redaction so multi-line PEM blocks are still recognised as a whole.
  let text = redactCredentials(value.replace(/\r\n?/g, "\n").replace(hiddenOrControl, ""));
  text = multiline
    ? text
        .replace(/\t/g, "  ")
        .replace(/[ \u00a0]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ");
  return truncateText(text.trim(), maximum);
}

export const MAX_GIT_LINK_LENGTH = 2_000;

/** The URL in canonical form when it is an https URL without credentials, else null. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_GIT_LINK_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return url.href.length > MAX_GIT_LINK_LENGTH ? null : url.href;
  } catch {
    return null;
  }
}
