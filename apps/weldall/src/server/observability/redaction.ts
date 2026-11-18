import { WELDALL_GIT_CREDENTIAL_PREFIX } from "../connectors/git-host";

/** Replacement for a redacted credential; the same placeholder the logger uses for masked keys. */
export const REDACTION_PLACEHOLDER = "[***]";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Basic credentials are base64 of `user:password`; plain words after "Basic" stay readable. */
function isBasicCredential(value: string): boolean {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return decoded.includes(":") && /^[\x20-\x7e]+$/.test(decoded);
}

/**
 * Prose such as "DPoP proof-of-possession" or "Bearer token_endpoint_auth_method": words of
 * lower-case letters (optionally capitalised) joined by `-`, `_` or `.`. A random token of 16 or
 * more characters almost never has this shape (all letters, no digits, no inner capitals).
 */
function isNotProse(value: string): boolean {
  return !/^[A-Z]?[a-z]+(?:[-_.][A-Z]?[a-z]+)*$/.test(value);
}

/**
 * Credential shapes that must never reach logs or audit metadata. Token patterns match by prefix
 * or structure and never assume a fixed length (GitHub is lengthening its installation tokens).
 * Lookbehinds keep labels such as `Authorization:` or `https://` readable around the placeholder.
 */
const credentialRules: ReadonlyArray<{ pattern: RegExp; accept?: (match: string) => boolean }> = [
  // PEM private keys of any kind, also when JSON-escaped or cut off before the END line.
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
  },
  // Header values, e.g. `Authorization: Basic …` or `"authorization":"Bearer …"`.
  {
    pattern:
      /(?<=\b(?:proxy-)?authorization["']?\s{0,8}[:=]\s{0,8}["']?)(?:[A-Za-z][A-Za-z0-9-]{0,30}\s{1,8})?[^\s"',;]+/gi,
  },
  // Userinfo in URLs, e.g. `https://x-access-token:…@github.com/`.
  { pattern: /(?<=\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/?#@"'<>]+(?=@)/gi },
  // Decoded Basic credentials of GitHub installation tokens outside a URL.
  { pattern: /(?<=\bx-access-token:)[^\s@"',;/]+/gi },
  // Forgejo access tokens are 40 hex digits, the same shape as a SHA-1 commit id, so they are only
  // recognised by their label: the decoded Basic userinfo the Forgejo provider sends
  // (`weldall:<token>`), and `token <token>` (Forgejo's header scheme) after an Authorization
  // label on the same line. A bare commit id stays readable.
  { pattern: /(?<=\bweldall:)[0-9a-f]{40}(?![0-9a-zA-Z])/g },
  {
    pattern:
      /(?<=\b(?:proxy-)?authorization\b[^\n]{0,64}?\btoken[ \t]{1,8})[0-9a-f]{40}(?![0-9a-zA-Z])/gi,
  },
  // GitHub token families and the Weldall git credential, by prefix and of any length.
  {
    pattern: new RegExp(
      String.raw`\b(?:gh[pousr]_|github_pat_|${escapeRegExp(WELDALL_GIT_CREDENTIAL_PREFIX)})[A-Za-z0-9_.-]{8,}`,
      "g",
    ),
  },
  // JWTs (JWS compact serialisation, including unsigned ones).
  // The lookbehind (instead of `\b`) lets only the first `eyJ` of a run start a match, which
  // keeps input such as `eyJ-eyJ-…` linear.
  { pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g },
  // Bare bearer-style tokens; short words and word compounds after "Bearer" in prose stay readable.
  // Lookbehind whitespace is bounded: an unbounded `\s+` is quadratic on long whitespace runs.
  { pattern: /(?<=\b(?:Bearer|DPoP)\s{1,8})[A-Za-z0-9._~+/-]{16,}=*/gi, accept: isNotProse },
  {
    pattern: /(?<=\bBasic\s{1,8})[A-Za-z0-9+/]{4,}={0,2}(?![A-Za-z0-9+/=])/gi,
    accept: isBasicCredential,
  },
];

/**
 * The credential patterns as plain regular expressions, for the logger's `mask.regex`. There the
 * accept checks do not run, so a word after "Basic", "Bearer" or "DPoP" may be masked in logs too.
 */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = credentialRules.map(({ pattern }) => pattern);

/** Replaces every credential-shaped substring with {@link REDACTION_PLACEHOLDER}. */
export function redactCredentials(text: string): string {
  return credentialRules.reduce(
    (redacted, { pattern, accept }) =>
      redacted.replace(pattern, (match) =>
        accept && !accept(match) ? match : REDACTION_PLACEHOLDER,
      ),
    text,
  );
}

/** {@link redactCredentials} applied to every string inside plain JSON-like data; keys are kept. */
export function redactCredentialsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactCredentials(value);
  if (Array.isArray(value)) return value.map(redactCredentialsDeep);
  if (
    value !== null &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactCredentialsDeep(entry)]),
    );
  return value;
}
