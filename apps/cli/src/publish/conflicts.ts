/**
 * Reading `git merge-tree --write-tree -z --messages` (verified with Apple Git 2.39.3):
 *
 *   <tree> NUL
 *   (<mode> SP <object> SP <stage> TAB <path> NUL)*   conflicted file info, absent when clean
 *   NUL
 *   (<count> NUL (<path> NUL){count} <type> NUL <message> NUL)*
 *
 * `<type>` is a stable token such as `CONFLICT (contents)`, `CONFLICT (binary)`,
 * `CONFLICT (modify/delete)` or `CONFLICT (rename/rename)`; `Auto-merging` is informational.
 */

/** How a conflicted file has to be decided. */
export type ConflictKind = "content" | "binary" | "modify-delete" | "rename" | "other";

/**
 * Decisions per conflicted file: `folder` keeps the file as it is now in the folder (after the
 * agent edited it), `local` takes the local version from before the merge, `repo` the
 * repository's version. A version may be "absent", which deletes the file.
 */
export type ConflictChoice = "folder" | "local" | "repo";

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
  /** What the merge saw: which side changed or removed the file. */
  description: string;
}

export interface MergeOutcome {
  /** Merged tree; on conflict it holds the files with markers and both versions of the rest. */
  tree: string;
  conflicts: ConflictFile[];
}

const order: ConflictKind[] = ["binary", "modify-delete", "rename", "other", "content"];

function kindOf(type: string): ConflictKind | null {
  if (!type.startsWith("CONFLICT")) return null;
  if (type === "CONFLICT (binary)") return "binary";
  if (type === "CONFLICT (modify/delete)") return "modify-delete";
  if (/rename/.test(type)) return "rename";
  if (type === "CONFLICT (contents)" || type === "CONFLICT (add/add)") return "content";
  return "other";
}

/**
 * Choices allowed per kind: binary and modify/delete always need an explicit side. Other
 * conflicts (file against directory, mode, submodule) take the repository's version: merge-tree
 * moves the local file aside under a generated name that must not be published. To keep the
 * local content, copy it to a new path in the folder before deciding; new paths stay.
 */
export function allowedChoices(kind: ConflictKind): ConflictChoice[] {
  if (kind === "other") return ["repo"];
  return kind === "binary" || kind === "modify-delete"
    ? ["local", "repo"]
    : ["folder", "local", "repo"];
}

/** Parses merge-tree output; throws when it does not have the documented shape. */
export function parseMergeTree(output: string, clean: boolean): MergeOutcome {
  const tokens = output.split("\0");
  const tree = tokens[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("git merge-tree returned no tree");
  let index = 1;
  const stagePaths = new Set<string>();
  while (index < tokens.length && tokens[index] !== "") {
    const match = /^\d{6} [0-9a-f]{40,64} [123]\t([\s\S]+)$/.exec(tokens[index]!);
    if (!match) throw new Error("git merge-tree returned an unexpected conflict entry");
    stagePaths.add(match[1]!);
    index += 1;
  }
  index += 1;
  const kinds = new Map<string, ConflictKind>();
  const descriptions = new Map<string, string>();
  while (index < tokens.length && tokens[index] !== "") {
    const count = Number.parseInt(tokens[index]!, 10);
    if (!Number.isInteger(count) || count < 1)
      throw new Error("git merge-tree returned an unexpected message");
    const paths = tokens.slice(index + 1, index + 1 + count);
    const type = tokens[index + 1 + count] ?? "";
    const message = (tokens[index + 2 + count] ?? "").trim();
    index += count + 3;
    const kind = kindOf(type);
    if (!kind) continue;
    for (const path of paths) {
      const current = kinds.get(path);
      if (!current || order.indexOf(kind) < order.indexOf(current)) {
        kinds.set(path, kind);
        descriptions.set(path, message);
      }
    }
  }
  if (clean) return { tree, conflicts: [] };
  const paths = new Set([...stagePaths, ...kinds.keys()]);
  const conflicts = [...paths].sort().map((path) => ({
    path,
    kind: kinds.get(path) ?? "other",
    description: descriptions.get(path) ?? "Both sides changed this path.",
  }));
  return { tree, conflicts };
}

/** Lines that git writes for a text conflict; their presence means a file is not resolved. */
export const hasConflictMarkers = (text: string) => /^(<{7}|>{7})( |$)/m.test(text);
