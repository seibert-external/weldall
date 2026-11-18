import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GIT_CREDENTIAL_HELPER } from "../git/repository-setup.js";
import { PublishError } from "./errors.js";
import type { GitRepository } from "./git.js";
import { CONFIG } from "./state.js";

/**
 * The folder's own git settings, checked before publish, sync or status works with the folder.
 * An agent working in the folder can write `.git/config`, and some settings make git start a
 * program that `GIT_HARDENING_OPTIONS` cannot switch off: a filter, diff or merge driver that
 * `.gitattributes` (or `.git/info/attributes`) names, a credential helper, an `include` of
 * another file with such settings. So the repository's own config may hold only what `git init`
 * writes, what publish and its set-up write, and a few settings that start nothing.
 *
 * The check runs once, and the agent can change the config afterwards. That is why every command
 * that could start such a program (anything that reads the working tree, checks it out, merges or
 * transfers) runs against a private git directory instead (`PrivateGitDirectory`), and the
 * commands that still read the folder's config start no program whatever it says.
 *
 * Derived from Git 2.39: `git init` writes `core.repositoryformatversion`, `filemode`, `bare`,
 * `logallrefupdates`, plus `ignorecase` and `precomposeunicode` on macOS and `symlinks` on
 * Windows (`--object-format=sha256` adds `extensions.objectformat`); `git clone` adds
 * `remote.<name>.*` and `branch.<name>.*`; `configureGitProxyRepository` writes
 * `remote.weldall.url`/`fetch` and the proxy-scoped `credential.<scope>.helper`/`useHttpPath`
 * and `http.<scope>.postBuffer`; publish writes the `weldall.*` keys of `CONFIG`. Also allowed:
 * `user.name`/`email`, `init.defaultBranch` and the line-ending settings `core.autocrlf`/`eol`,
 * which people set by hand and which start nothing.
 */
const CORE_KEYS = new Set([
  "repositoryformatversion",
  "filemode",
  "bare",
  "logallrefupdates",
  "ignorecase",
  "precomposeunicode",
  "symlinks",
  "autocrlf",
  "eol",
  // The command-line `core.hooksPath` outranks it; hook managers set it on install.
  "hookspath",
]);
/** Settings the private git directory takes over, so it reads the working tree the same way. */
export const PRIVATE_CONFIG_KEYS = [
  "core.repositoryformatversion",
  "core.filemode",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "core.autocrlf",
  "core.eol",
  "extensions.objectformat",
] as const;
/** Values of the settings above: a word or number, nothing that could break the config file. */
const PLAIN_VALUE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Only used when fetching or pushing by remote name, which publish never does; no programs. */
const REMOTE_KEYS = new Set(["url", "pushurl", "fetch", "tagopt", "prune"]);
const WELDALL_KEYS = new Set(
  Object.values(CONFIG).map((key) => key.slice("weldall.".length).toLowerCase()),
);

export interface ConfigEntry {
  /** As git prints it: section and name in lower case, the subsection as written. */
  key: string;
  section: string;
  subsection: string | null;
  name: string;
  /** null for a key written without `=` (git reads it as true). */
  value: string | null;
}

/** Parses `git config --list --show-scope -z` into the entries of the given scopes. */
export function parseConfigList(output: string, scopes: readonly string[]): ConfigEntry[] {
  const tokens = output.split("\0");
  const entries: ConfigEntry[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    if (!scopes.includes(tokens[index]!)) continue;
    const record = tokens[index + 1]!;
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    entries.push({
      key,
      section: key.slice(0, first),
      subsection: first === last ? null : key.slice(first + 1, last),
      name: key.slice(last + 1),
      value: newline === -1 ? null : record.slice(newline + 1),
    });
  }
  return entries;
}

/** Whether a repository-local setting is one publish expects and that starts no program. */
export function isAllowedConfigEntry({ section, subsection, name, value }: ConfigEntry): boolean {
  const plain = subsection === null;
  switch (section) {
    case "core":
      return (
        plain &&
        CORE_KEYS.has(name) &&
        (name === "hookspath" || value === null || PLAIN_VALUE.test(value))
      );
    case "extensions":
      return plain && name === "objectformat" && value !== null && PLAIN_VALUE.test(value);
    case "user":
      return plain && (name === "name" || name === "email");
    case "init":
      return plain && name === "defaultbranch";
    case "weldall":
      return plain && WELDALL_KEYS.has(name);
    case "branch":
      return !plain;
    case "remote":
      // `remote.<URL>.*` would apply to publish's fetch and push by URL.
      return !plain && !subsection.includes(":") && REMOTE_KEYS.has(name);
    case "credential":
      if (plain) return false;
      if (name === "usehttppath") return true;
      // The empty value only clears the helpers before it; any other helper is a program.
      return name === "helper" && (value === "" || value === GIT_CREDENTIAL_HELPER);
    case "http":
      return !plain && name === "postbuffer";
    default:
      return false;
  }
}

/** Key names come from a file anyone in the folder can write: shown printable and bounded. */
const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

const SHOWN_KEYS = 10;

/**
 * Refuses a repository whose own git settings could make git start a program, or whose object
 * store borrows from another location. Reading runs nothing: `git config` touches neither the
 * index nor the working tree, does not follow `include`s here, and runs with the hardening
 * options. Call before any git command that reads the working tree or writes refs. Returns the
 * (allowed) entries.
 */
export async function assertSafeRepository(git: GitRepository): Promise<ConfigEntry[]> {
  const listed = await git.run(["config", "--list", "--show-scope", "-z", "--no-includes"]);
  const entries = parseConfigList(listed.stdout.toString("utf8"), ["local", "worktree"]);
  const refused = [
    ...new Set(
      entries.filter((entry) => !isAllowedConfigEntry(entry)).map(({ key }) => printable(key)),
    ),
  ];
  if (refused.length) {
    const shown = refused.slice(0, SHOWN_KEYS).join(", ");
    const more = refused.length > SHOWN_KEYS ? ` and ${refused.length - SHOWN_KEYS} more` : "";
    const one = refused.length === 1;
    throw new PublishError(
      "unsafe_git_config",
      `The git settings of this folder contain ${one ? "an entry" : "entries"} Weldall does not allow: ${shown}${more}. Settings like ${one ? "this" : "these"} can make git start other programs on this computer, so Weldall stops before working with the folder. Nothing was published and nothing in the folder changed. If you did not add ${one ? "it" : "them"} yourself, something working in this folder (for example an AI agent) did. Remove ${one ? "it" : "them"}, then try again.`,
      {
        hint: "Remove each entry with `git config --local --unset-all <name>` (a whole section with `git config --local --remove-section <section>`).",
        details: { keys: refused.join(", ") },
      },
    );
  }

  const alternates = resolve(
    git.directory,
    await git.text(["rev-parse", "--git-path", "objects/info/alternates"]),
  );
  const borrowed = await readFile(alternates, "utf8").then(
    (text) => text.split("\n").some((line) => line.trim() && !line.startsWith("#")),
    () => false,
  );
  if (borrowed)
    throw new PublishError(
      "unsafe_git_objects",
      `The git repository of this folder uses stored data from another location (${alternates}). Weldall only works with folders that keep all their git data themselves, so it stops before working with the folder. Nothing was published and nothing in the folder changed. If you did not set this up yourself, something working in this folder (for example an AI agent) did.`,
      {
        hint: "If the folder was made with `git clone --shared` or `--reference`, run `git repack -a -d` in it and then delete that file; otherwise delete the file. Then try again.",
      },
    );
  return entries;
}
