import { constants } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../storage/atomic-write.js";
import type { Folder } from "./folder.js";
import { PublishError } from "./errors.js";
import { printable } from "../git/printable.js";
import type { GitRepository } from "./git.js";

/**
 * Where publish keeps its state: everything lives in the folder's own repository, so it moves
 * with the folder and needs no account.
 *
 * Local git config (`git config --local`):
 * - `weldall.template`, `weldall.templateCommit`: the agreement with app templates. The
 *   folder is a git repository without a Weldall remote whose first commit is the template state;
 *   whoever creates the folder records the template name and that commit. Publish never guesses
 *   them.
 * - `weldall.appId`, `weldall.appName`, `weldall.registry`, `weldall.remoteUrl`,
 *   `weldall.repositoryUrl`: the app, recorded by the first publish. `weldall.registry` is the
 *   resource key of the registry that keeps the app; it and the git URL are checked against
 *   Weldall's resource registry and the registry's metadata on every use (`registry-choice.ts`).
 *   The repository's default branch is not recorded: a fetch takes the repository's `HEAD`.
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
  registry: "weldall.registry",
  remoteUrl: "weldall.remoteUrl",
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

/** A full git object id (SHA-1 or SHA-256), the only form publish records or reads back. */
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const isObjectId = (value: string) => OBJECT_ID.test(value);

/** One line of printable text, not read as an option: no control characters, no leading `-`. */
const plainText = (maximum: number) => (value: string) =>
  value.length >= 1 &&
  value.length <= maximum &&
  !value.startsWith("-") &&
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);

/** A plain https URL (no credentials), as the registry answers links. */
const httpsUrl = (value: string) => {
  if (!plainText(2_000)(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

/**
 * Every `weldall.*` value publish reads back, with what Weldall would ever write there. The
 * folder's config is writable by anything working in the folder (an agent included), so each
 * value is checked on every read and treated as hostile until it passes.
 */
const STATE_VALUES: Record<(typeof CONFIG)[keyof typeof CONFIG], (value: string) => boolean> = {
  [CONFIG.template]: plainText(200),
  [CONFIG.templateCommit]: isObjectId,
  [CONFIG.appId]: (value) => /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(value),
  [CONFIG.appName]: plainText(200),
  [CONFIG.registry]: (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value),
  // Its shape is checked again by `parseRecordedRemote`, with a message of its own.
  [CONFIG.remoteUrl]: plainText(2_000),
  [CONFIG.repositoryUrl]: httpsUrl,
  [CONFIG.prBranch]: (value) => value.startsWith("weldall/publish-") && isBranchName(value),
  [CONFIG.prNumber]: (value) => /^[1-9][0-9]{0,9}$/.test(value),
  [CONFIG.prUrl]: httpsUrl,
};

export type StateKey = keyof typeof STATE_VALUES;

/** Reads a `weldall.*` value of the folder's config; refuses one Weldall would never write. */
export async function readState(git: GitRepository, key: StateKey): Promise<string | null> {
  const value = await git.config(key);
  if (value === null || STATE_VALUES[key](value)) return value;
  throw new PublishError(
    "state_invalid",
    `The folder's git config holds a value for ${key} that Weldall never writes, so Weldall stops before using it. Nothing was published and nothing in the folder changed. If you did not change it yourself, something working in this folder (for example an AI agent) did.`,
    { hint: `Restore ${key} from a backup of the folder, or ask for help.` },
  );
}

/** Refuses a value that a later read would refuse (`state_value_refused`). */
export function assertStateValue(key: StateKey, value: string): void {
  if (!STATE_VALUES[key](value))
    throw new PublishError(
      "state_value_refused",
      `Weldall does not record "${printable(value, 200)}" as ${key}: it is too long, has control characters, or is not of the expected form. It comes from the registry's answer or from the command's options. Nothing was recorded.`,
      {
        hint: "Check the option you gave; otherwise ask your Weldall administrator to check the registry.",
      },
    );
}

/**
 * Records a `weldall.*` value, refusing one that a later read would refuse: the registry's
 * answers end up here too, so the folder never holds a value it cannot use again.
 */
export async function writeState(git: GitRepository, key: StateKey, value: string): Promise<void> {
  assertStateValue(key, value);
  await git.setConfig(key, value);
}

/** The values a first publish records about the app besides its id, which comes last. */
export const APP_RECORD = [
  CONFIG.appName,
  CONFIG.registry,
  CONFIG.remoteUrl,
  CONFIG.repositoryUrl,
] as const;

/** A folder that records an app id without its registry or git URL. */
export const stateIncomplete = (appId: string) =>
  new PublishError(
    "state_incomplete",
    `The folder records app ${appId} but not its registry or git URL (${CONFIG.registry}, ${CONFIG.remoteUrl}). Weldall records the app id last, so these were removed afterwards.`,
    {
      hint: `Restore them from a backup of the folder; or remove ${CONFIG.appId} (\`git config --unset ${CONFIG.appId}\`) and publish again with the app's --name and --description: the registry answers the same app and the folder records it again.`,
    },
  );

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

/**
 * A path as merge-tree reports it: relative, without empty, `.` or `..` segments or NUL. Paths
 * reach git only after `--` or inside `--cacheinfo`, never where they could be read as an option.
 */
const treePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (path) =>
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  );
const objectId = z.string().regex(OBJECT_ID);

const conflictFile = z.object({
  path: treePath,
  kind: z.enum(["content", "binary", "modify-delete", "rename", "other"]),
  description: z.string().max(4_000),
});

/**
 * A conflict whose merge result was written into the folder for the agent to resolve. The file
 * lies inside the folder's `.git`, which an agent can write: every object is a full object id,
 * every other value is bounded, and unknown keys are refused.
 */
export const pendingConflictSchema = z
  .object({
    version: z.literal(1),
    /** Base commit of the merge (the old `refs/weldall/base`). */
    base: objectId,
    /** Fetched repository commit of the merge. */
    repo: objectId,
    /** Local commit that saved the folder right before the result was written. */
    local: objectId,
    /** The merge's local side (folder plus protected paths from the repository). */
    input: objectId,
    /** Merge result tree with markers, as written into the folder. */
    merge: objectId,
    files: z
      .array(conflictFile)
      .min(1)
      .max(10_000)
      .refine((files) => new Set(files.map(({ path }) => path)).size === files.length),
  })
  .strict();
export type PendingConflict = z.output<typeof pendingConflictSchema>;

const conflictPath = (folder: Folder) => join(folder.stateDirectory, "conflict.json");
/** A stored resolution is small (paths and short descriptions); a larger file is not one of ours. */
const MAX_CONFLICT_FILE_BYTES = 16 * 1024 * 1024;

export async function readPendingConflict(folder: Folder): Promise<PendingConflict | null> {
  let text = "";
  let handle;
  try {
    // Never follows a link an agent placed there (O_NOFOLLOW where the system has it).
    handle = await open(
      conflictPath(folder),
      // A FIFO would block a plain open; O_NONBLOCK lets the type check below refuse it.
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  }
  if (handle)
    try {
      const stats = await handle.stat();
      // Not a regular file of a size Weldall writes: refused like unreadable content.
      text =
        stats.isFile() && stats.size <= MAX_CONFLICT_FILE_BYTES
          ? await handle.readFile("utf8")
          : "";
    } finally {
      await handle.close();
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
  // Never stores what a later read would refuse.
  pendingConflictSchema.parse(conflict);
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
  await atomicWriteFile(conflictPath(folder), `${JSON.stringify(conflict, null, 2)}\n`);
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
