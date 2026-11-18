import { GitAppError } from "../errors.js";
import { withoutHiddenCharacters } from "../git-text.js";

/**
 * Pull request title and body, carried over unchanged from the server's
 * `app-registry/pull-requests.ts`. Into the customer's Git goes only a reference to the person:
 * the opaque Weldall user id, never a name or an email address.
 */

/** Bounds for the caller's title and body; GitHub allows 65,536 characters of body. */
export const PULL_REQUEST_TITLE_LIMIT = 200;
export const PULL_REQUEST_BODY_LIMIT = 16_000;

/**
 * Hidden marker before the trigger line. Markdown renders it invisibly; it lets reviewers and
 * tools find the server's line, and is removed from the caller's text so it cannot be imitated.
 */
export const PUBLISH_TRIGGER_MARKER = "<!-- weldall:published-by -->";
const markerPattern = /<!--\s*weldall:published-by\s*-->/gi;

/**
 * Look-alike folding for matching only: compatibility forms, accents, case, common Cyrillic and
 * Greek homoglyphs and digit look-alikes collapse to plain Latin letters; everything else is
 * dropped. `i` and `l` fold together (`I`/`l`/`1`).
 */
const confusables: Record<string, string> = {
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "i",
  "\u0458": "j",
  "\u0455": "s",
  "\u0501": "d",
  "\u04bb": "h",
  "\u04cf": "l",
  "\u051d": "w",
  "\u0432": "b",
  "\u043a": "k",
  "\u043c": "m",
  "\u043d": "h",
  "\u0442": "t",
  "\u03bf": "o",
  "\u03b1": "a",
  "\u03b5": "e",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bd": "v",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u0251": "a",
  "\u0261": "g",
  "\u026a": "i",
  "\u029f": "l",
  "0": "o",
  "1": "l",
  "3": "e",
  "5": "s",
  "|": "l",
};
const skeleton = (value: string) =>
  [
    ...value
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase(),
  ]
    .map((character) => confusables[character] ?? character)
    .join("")
    .replace(/[^a-z]+/g, "")
    .replace(/i/g, "l");
const triggerSkeletons = [
  "published with weldall",
  "published through weldall",
  "published via weldall",
  "weldall user",
].map(skeleton);
/** Whether a line of the caller's text imitates the trigger line, also with look-alike characters. */
const imitatesTrigger = (line: string) => {
  const folded = skeleton(line);
  return triggerSkeletons.some((pattern) => folded.includes(pattern));
};

/**
 * The line the server puts at the top of every pull request body. It stays in the customer's Git
 * for good, so it carries only a reference: the opaque Weldall user id, which only Weldall's audit
 * resolves to a person. No name and no email address (decided 2026-11-17: only a reference goes
 * into the customer's Git for now).
 */
export function publishTriggerLine(person: { id: string }): string {
  return `Published with Weldall (Weldall user ${person.id}).`;
}

/** Removes control characters except line breaks and tabs, and normalises line ends. */
const withoutControls = (value: string) =>
  value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** The caller's title as one bounded line. */
export function pullRequestTitle(value: string): string {
  const title = withoutControls(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PULL_REQUEST_TITLE_LIMIT);
  if (!title) throw new GitAppError("invalid_request", "Give the pull request a title.");
  return title;
}

/**
 * The pull request body: the marker and the server's trigger line first, then the caller's text
 * after a rule. Nothing the caller writes can precede or collapse the trigger line (an unclosed
 * `<details>` only hides the caller's own text). Hidden characters are stripped from the caller's
 * text, and copies of the marker and lines that imitate the trigger line, also with look-alike
 * characters, are removed.
 */
export function pullRequestBody(value: string, person: { id: string }): string {
  const body = withoutHiddenCharacters(withoutControls(value).slice(0, PULL_REQUEST_BODY_LIMIT))
    .replace(markerPattern, "")
    .split("\n")
    .filter((line) => !imitatesTrigger(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const trigger = `${PUBLISH_TRIGGER_MARKER}\n${publishTriggerLine(person)}`;
  // The blank line keeps the rule from turning the trigger line into a heading.
  return body ? `${trigger}\n\n---\n\n${body}` : trigger;
}
