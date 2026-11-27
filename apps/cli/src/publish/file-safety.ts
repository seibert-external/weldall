import { PublishError } from "./errors.js";

/**
 * Which files a publish refuses to send. Publish includes tracked changes and untracked files
 * that `.gitignore` does not exclude, so a person without git knowledge could publish a `.env` or
 * a database dump by accident. Every file the publish would add or change is checked by name, by
 * size, and (small text files) by content; any hit stops the publish before anything is sent.
 * The fix is to remove the file or add it to `.gitignore`, never a flag that skips the check.
 */

/** Larger files are refused: data dumps and build output do not belong in an app's repository. */
export const MAX_PUBLISHED_FILE_BYTES = 10 * 1024 * 1024;
/** Text files up to this size are scanned for credentials and conflict markers. */
export const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

/** `.env` files meant to be committed: documented examples without real values. */
const EXAMPLE_ENV = /^\.env\.(example|sample|template|dist|defaults)$/i;

const SECRET_NAMES: ReadonlyArray<{ test: (name: string, path: string) => boolean; why: string }> =
  [
    {
      test: (name) => (name === ".env" || name.startsWith(".env.")) && !EXAMPLE_ENV.test(name),
      why: "environment file, usually holds secrets (example files such as .env.example are allowed)",
    },
    {
      test: (name) =>
        /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i.test(name) ||
        /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i.test(name),
      why: "private key or keystore",
    },
    {
      test: (name, path) =>
        /^(\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.htpasswd|\.pgpass|\.dockercfg|credentials\.json|client_secret.*\.json|service[-_]?account.*\.json)$/i.test(
          name,
        ) || /(^|\/)\.(aws|docker|kube|ssh|gnupg)\//i.test(path),
      why: "credentials file",
    },
    {
      test: (name) => /\.(sqlite3?|db|dump|bak|tfstate|tfstate\.backup)$/i.test(name),
      why: "database file, dump or state file",
    },
  ];

/**
 * Credential shapes, matching the organisation's secret patterns: GitHub, HubSpot, AWS,
 * OpenAI/Stripe and Slack tokens, JWTs, PEM private keys, and the Weldall git credential.
 */
const SECRET_CONTENT: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/, why: "a private key" },
  { pattern: /\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/, why: "a GitHub token" },
  { pattern: /\bpat-(na1|eu1)-[0-9a-f-]{20,}/i, why: "a HubSpot token" },
  { pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, why: "an AWS access key" },
  { pattern: /\bsk-(proj-|live_|test_)?[A-Za-z0-9_-]{20,}/, why: "an API secret key" },
  { pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/, why: "a Stripe secret key" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, why: "a Slack token" },
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
    why: "a JWT",
  },
  { pattern: /\bwgc_[A-Za-z0-9_.-]{8,}/, why: "a Weldall git credential" },
];

const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

export interface CandidateFile {
  path: string;
  /** Git file mode: 100644/100755 file, 120000 symlink (text = target), 160000 nested repository. */
  mode?: string;
  /**
   * True when the path is already in the last agreed state (e.g. the template's own `.npmrc`).
   * Such files are not refused by name, only by content, so a changed template file is never a
   * dead end; new files are refused by name too.
   */
  inBase?: boolean;
  size: number;
  /** Content for text files up to {@link MAX_SCANNED_FILE_BYTES}; null for binary or larger files. */
  text: string | null;
}

export interface RefusedFile {
  path: string;
  reason: string;
}

/** Whether a blob's first bytes look binary (git's own heuristic: a NUL byte). */
export const looksBinary = (bytes: Buffer) => bytes.subarray(0, 8000).includes(0);

/** Refusal reason by name alone, or null. */
export function refusalByName(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return SECRET_NAMES.find(({ test }) => test(name, path))?.why ?? null;
}

/** Total size of all files one publish may add or change, matching the git proxy's 100 MB limit. */
export const MAX_PUBLISH_BYTES = 100 * 1024 * 1024;

/** merge-tree's name for a file moved aside by a file/directory conflict. */
const MERGE_ASIDE = /~refs_weldall_(local|repo)(\/|$)/;

/** Why a symlink must not be published: a target outside the folder exposes the device's paths. */
function symlinkRefusal(path: string, target: string): string | null {
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target))
    return `symbolic link to an absolute path (${target.slice(0, 200)}); link to a file inside the folder with a relative path, or remove it`;
  const depth = path.split("/").length - 1;
  let level = depth;
  for (const part of target.split("/")) {
    if (part === "..") level -= 1;
    else if (part && part !== ".") level += 1;
    if (level < 0) return "symbolic link to a place outside the folder; remove it";
  }
  return null;
}

/** Why `file` must not be published, or null when it may be. */
export function refusalReason(file: CandidateFile): string | null {
  if (file.mode === "160000")
    return "folder with its own git repository (a nested .git folder), which would be published as an empty reference without its files; delete that folder's .git directory, or add the folder to .gitignore";
  if (MERGE_ASIDE.test(file.path))
    return "file moved aside by a conflict; give it a real name or remove it";
  if (file.mode === "120000") return symlinkRefusal(file.path, file.text ?? "");
  const byName = file.inBase ? null : refusalByName(file.path);
  if (byName) return byName;
  if (file.size > MAX_PUBLISHED_FILE_BYTES)
    return `larger than ${MAX_PUBLISHED_FILE_BYTES / 1024 / 1024} MB`;
  if (file.text === null) return null;
  if (CONFLICT_MARKER.test(file.text)) return "contains conflict markers (<<<<<<< or >>>>>>>)";
  const secret = SECRET_CONTENT.find(({ pattern }) => pattern.test(file.text!));
  return secret ? `contains what looks like ${secret.why}` : null;
}

/** A readable stop for a publish that is far too large, naming where the bulk is. */
export function tooMuch(files: ReadonlyArray<{ path: string; size: number }>): PublishError {
  const directories = new Map<string, number>();
  for (const { path, size } of files) {
    const parts = path.split("/");
    const directory = parts.length > 1 ? `${parts[0]}/` : path;
    directories.set(directory, (directories.get(directory) ?? 0) + size);
  }
  const largest = [...directories]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([directory, size]) => `${directory} (${Math.round(size / 1024 / 1024)} MB)`);
  return new PublishError(
    "too_large",
    `The folder has more new or changed files than one publish can send (over ${MAX_PUBLISH_BYTES / 1024 / 1024} MB). Largest: ${largest.join(", ")}. These are usually installed packages, environments or build output; add them to .gitignore (for example node_modules/, .venv/, dist/) and publish again.`,
  );
}
