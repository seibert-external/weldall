import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Folder } from "./folder.js";
import { PublishError } from "./errors.js";
import type { GitRepository } from "./git.js";

/**
 * Where publish keeps its state: everything lives in the folder's own repository, so it moves
 * with the folder and needs no account.
 *
 * Local git config (`git config --local`):
 * - `weldall.template`, `weldall.templateCommit`: the agreement with INV-185 (app templates). The
 *   folder is a git repository without a Weldall remote whose first commit is the template state;
 *   whoever creates the folder records the template name and that commit. Publish never guesses
 *   them.
 * - `weldall.appId`, `weldall.appName`, `weldall.gitApp`, `weldall.remoteUrl`,
 *   `weldall.defaultBranch`, `weldall.repositoryUrl`: the app, recorded by the first publish.
 *   `weldall.gitApp` is the resource key of the Git app that keeps the repository; it and the git
 *   URL are checked against Weldall's resource registry on every use (`git-app-choice.ts`).
 * - `weldall.prBranch`, `weldall.prNumber`, `weldall.prUrl`: the current publish branch and its
 *   pull request.
 *
 * Refs: `refs/weldall/base` (tree last agreed with the repository: the template commit, then
 * the last pushed commit or fetched state), `refs/weldall/pr-base` (repository state the current
 * pull request was built on), `refs/weldall/theirs` (last fetched state), `refs/weldall/conflict/*`
 * (objects of a conflict resolution). `.git/weldall/conflict.json` holds that resolution.
 */
export const CONFIG = {
  template: "weldall.template",
  templateCommit: "weldall.templateCommit",
  appId: "weldall.appId",
  appName: "weldall.appName",
  gitApp: "weldall.gitApp",
  remoteUrl: "weldall.remoteUrl",
  defaultBranch: "weldall.defaultBranch",
  repositoryUrl: "weldall.repositoryUrl",
  prBranch: "weldall.prBranch",
  prNumber: "weldall.prNumber",
  prUrl: "weldall.prUrl",
} as const;

/**
 * A branch name as git and the hosts take it, never read as an option or a refspec: starts with
 * a letter or digit (no `-`, no `+`), and none of `:`, `*`, `?`, `[`, `\`, `^`, `~`, `{`,
 * spaces or control characters, nor the sequences git refuses (`..`, `//`, `/.`, `.lock`).
 */
export const isBranchName = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._/+@#,=_-]{0,199}$/.test(value) &&
  !/\.\.|\/\/|\/\.|\.lock(\/|$)|[./]$/.test(value);

/**
 * The recorded values that become git arguments or API paths. The folder's config is writable
 * by anything working in the folder, so they are checked on every read.
 */
const STATE_VALUES: Partial<Record<string, (value: string) => boolean>> = {
  [CONFIG.templateCommit]: (value) => /^[0-9a-f]{4,64}$/i.test(value),
  [CONFIG.appId]: (value) => /^[A-Za-z0-9_-]{1,64}$/.test(value),
  [CONFIG.gitApp]: (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value),
  [CONFIG.defaultBranch]: isBranchName,
  [CONFIG.prBranch]: (value) => value.startsWith("weldall/publish-") && isBranchName(value),
};

/** Reads a `weldall.*` value of the folder's config; refuses one Weldall would never write. */
export async function readState(git: GitRepository, key: string): Promise<string | null> {
  const value = await git.config(key);
  const valid = STATE_VALUES[key];
  if (value === null || !valid || valid(value)) return value;
  throw new PublishError(
    "state_invalid",
    `The folder's git config holds a value for ${key} that Weldall never writes, so Weldall stops before using it. Nothing was published and nothing in the folder changed. If you did not change it yourself, something working in this folder (for example an AI agent) did.`,
    { hint: `Restore ${key} from a backup of the folder, or ask for help.` },
  );
}

export const REFS = {
  base: "refs/weldall/base",
  prBase: "refs/weldall/pr-base",
  theirs: "refs/weldall/theirs",
  prHead: "refs/weldall/pr-head",
  conflictRepo: "refs/weldall/conflict/repo",
  conflictLocal: "refs/weldall/conflict/local",
  conflictInput: "refs/weldall/conflict/input",
  conflictMerge: "refs/weldall/conflict/merge",
} as const;

const conflictFile = z.object({
  path: z.string(),
  kind: z.enum(["content", "binary", "modify-delete", "rename", "other"]),
  description: z.string(),
});

/** A conflict whose merge result was written into the folder for the agent to resolve. */
export const pendingConflictSchema = z.object({
  version: z.literal(1),
  /** Base commit of the merge (the old `refs/weldall/base`). */
  base: z.string(),
  /** Fetched repository commit of the merge. */
  repo: z.string(),
  /** Local commit that saved the folder right before the result was written. */
  local: z.string(),
  /** The merge's local side (folder plus protected paths from the repository). */
  input: z.string(),
  /** Merge result tree with markers, as written into the folder. */
  merge: z.string(),
  files: z.array(conflictFile).min(1),
});
export type PendingConflict = z.output<typeof pendingConflictSchema>;

const conflictPath = (folder: Folder) => join(folder.stateDirectory, "conflict.json");

export async function readPendingConflict(folder: Folder): Promise<PendingConflict | null> {
  let text: string;
  try {
    text = await readFile(conflictPath(folder), "utf8");
  } catch {
    return null;
  }
  const parsed = pendingConflictSchema.safeParse(
    (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success)
    throw new PublishError(
      "conflict_state_invalid",
      `The stored conflict resolution in ${conflictPath(folder)} is unreadable. Delete that file and publish again; the merge then starts over from the last agreed state.`,
    );
  return parsed.data;
}

/** Stores the resolution and pins its objects with refs, so `git gc` keeps them. */
export async function writePendingConflict(folder: Folder, conflict: PendingConflict) {
  const { repository } = folder;
  await repository.updateRef(REFS.conflictRepo, conflict.repo);
  await repository.updateRef(REFS.conflictLocal, conflict.local);
  await repository.updateRef(
    REFS.conflictInput,
    await folder.commitTree(conflict.input, [], "weldall conflict: local side"),
  );
  await repository.updateRef(
    REFS.conflictMerge,
    await folder.commitTree(conflict.merge, [], "weldall conflict: merge result"),
  );
  await mkdir(folder.stateDirectory, { recursive: true });
  await writeFile(conflictPath(folder), `${JSON.stringify(conflict, null, 2)}\n`, { mode: 0o600 });
}

export async function clearPendingConflict(folder: Folder) {
  await rm(conflictPath(folder), { force: true });
  for (const ref of [REFS.conflictRepo, REFS.conflictLocal, REFS.conflictInput, REFS.conflictMerge])
    await folder.repository.deleteRef(ref);
}

/** A lock older than this is left over from a run that was killed (a publish takes minutes). */
export const STALE_LOCK_MS = 60 * 60_000;

/** Whether a lock file belongs to a run that no longer exists. */
async function isStale(path: string): Promise<boolean> {
  try {
    const [text, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) return true;
    const pid = Number.parseInt(text, 10);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

/** One publish per folder at a time; git operations inside run one after another. */
export async function acquirePublishLock(folder: Folder): Promise<() => Promise<void>> {
  await mkdir(folder.stateDirectory, { recursive: true });
  const path = join(folder.stateDirectory, "publish.lock");
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && (await isStale(path))) {
        await rm(path, { force: true });
        continue;
      }
      throw new PublishError(
        "busy",
        `Another publish or sync is running in this folder. If none is running, delete ${path} and try again.`,
      );
    }
  }
}
