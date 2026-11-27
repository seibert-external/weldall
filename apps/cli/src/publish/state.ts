import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, open, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile, isEpermError } from "../storage/atomic-write.js";
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

/** Whether `value` is one Weldall would write as `key` (and so read back). */
export const isStateValue = (key: StateKey, value: string) => STATE_VALUES[key](value);

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
export const isTreePath = (path: string) =>
  path.length >= 1 &&
  path.length <= 4_096 &&
  !path.includes("\0") &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
const treePath = z.string().refine(isTreePath);
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

const CONFLICT_FILE = "conflict.json";
const conflictPath = (folder: Folder) => join(folder.stateDirectoryPath, CONFLICT_FILE);
/** A stored resolution is small (paths and short descriptions); a larger file is not one of ours. */
const MAX_CONFLICT_FILE_BYTES = 16 * 1024 * 1024;

/** A state file as read: its text and stats, `missing`, or `unusable` (not a regular file). */
export type StateFile = { text: string; stats: Stats } | "missing" | "unusable";

/**
 * Reads one of publish's own files below the git directory without ever blocking or following a
 * link: opened with `O_NOFOLLOW | O_NONBLOCK` (where the system has them; a FIFO would block a
 * plain open forever), then only a regular file of at most `maximumBytes` is read, and no more
 * than that. A link, FIFO, directory or larger file is `unusable`.
 */
export async function readStateFile(path: string, maximumBytes: number): Promise<StateFile> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unusable";
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximumBytes) return "unusable";
    // Bounded even when the file grows after the check.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximumBytes) return "unusable";
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return { text: Buffer.concat(chunks).toString("utf8"), stats };
  } catch {
    return "unusable";
  } finally {
    await handle.close();
  }
}

export async function readPendingConflict(folder: Folder): Promise<PendingConflict | null> {
  const directory = await folder.stateDirectory(false);
  if (directory === null) return null;
  const file = await readStateFile(join(directory, CONFLICT_FILE), MAX_CONFLICT_FILE_BYTES);
  if (file === "missing") return null;
  const parsed = pendingConflictSchema.safeParse(
    (() => {
      try {
        // Not a regular file of a size Weldall writes: refused like unreadable content.
        return typeof file === "string" ? null : (JSON.parse(file.text) as unknown);
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
  await atomicWriteFile(
    join(await folder.stateDirectory(true), CONFLICT_FILE),
    `${JSON.stringify(conflict, null, 2)}\n`,
  );
}

export async function clearPendingConflict(folder: Folder) {
  const directory = await folder.stateDirectory(false);
  if (directory !== null) await rm(join(directory, CONFLICT_FILE), { force: true });
  for (const ref of [REFS.conflictRepo, REFS.conflictLocal, REFS.conflictInput, REFS.conflictMerge])
    await folder.repository.deleteRef(ref);
}

/**
 * A lock whose timestamp is older than this is left over from a run that was killed. A running
 * publish refreshes its lock's timestamp every {@link LOCK_REFRESH_MS}, so a long run keeps it.
 */
export const STALE_LOCK_MS = 60 * 60_000;
export const LOCK_REFRESH_MS = 5 * 60_000;
const LOCK_FILE = "publish.lock";
/** `<pid> <token>\n`; anything longer is not a lock Weldall wrote. */
const MAX_LOCK_BYTES = 1_024;

/** Whether the lock read as `file` belongs to a run that no longer exists. */
function isStale(file: { text: string; stats: Stats }): boolean {
  if (Date.now() - file.stats.mtimeMs > STALE_LOCK_MS) return true;
  // Empty: a lock written by hand or a run killed while writing it; stale only by its age.
  if (!file.text.trim()) return false;
  const pid = Number.parseInt(file.text, 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

const busy = (path: string, extra = "") =>
  new PublishError(
    "busy",
    `Another publish or sync is running in this folder${extra}. If none is running, delete ${path} and try again.`,
  );

/** A rename that, like `atomicWriteFile`, tolerates Windows' momentary EPERM from an open reader. */
async function renameWithRetry(from: string, to: string) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!isEpermError(error) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
    }
  }
}

const sameLock = (
  a: { text: string; stats: Stats } | StateFile,
  b: { text: string; stats: Stats },
) =>
  typeof a !== "string" &&
  a.stats.dev === b.stats.dev &&
  a.stats.ino === b.stats.ino &&
  a.text === b.text;

/**
 * Creates the lock with its full content in one step: written to a private name first, then
 * hard-linked to `path`, which fails when a lock exists (so no other run ever reads a half-written
 * lock). Returns an open handle on the lock (for refreshing its timestamp), or null when a lock
 * exists. Where hard links are not available, the lock is created with `wx` directly.
 */
async function createLock(path: string, content: string, token: string) {
  const temporary = `${path}.${token}.new`;
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(temporary, flags, 0o600);
  try {
    await handle.writeFile(content);
    try {
      await link(temporary, path);
      return handle;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        await handle.close();
        return null;
      }
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV")
        throw error;
    }
    await handle.close();
    try {
      const direct = await open(path, flags, 0o600);
      await direct.writeFile(content);
      return direct;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * One publish per folder at a time; git operations inside run one after another.
 *
 * The lock (`publish.lock` in the state directory) holds `<pid> <token>`. It is created
 * atomically (see {@link createLock}); a running publish refreshes its timestamp, and releasing
 * removes it only while it still holds this run's token. A stale lock (its process is gone, or
 * its timestamp was not refreshed for {@link STALE_LOCK_MS}) is taken over by exactly one run:
 * the run that creates `publish.lock.break-<id>` (exclusively; the id names the stale lock's
 * inode and content) moves the lock aside only after checking it is still that stale lock, and
 * creates its own before giving up the break file. Every run that saw the same stale lock but did
 * not win reports `busy`.
 */
export async function acquirePublishLock(folder: Folder): Promise<() => Promise<void>> {
  const directory = await folder.stateDirectory(true);
  const path = join(directory, LOCK_FILE);
  const token = randomBytes(16).toString("hex");
  const content = `${process.pid} ${token}\n`;

  const held = (handle: FileHandle) => {
    const refresh = setInterval(() => {
      const now = new Date();
      // The handle names this run's own lock: a lock that replaced it is never touched.
      handle.utimes(now, now).catch(() => undefined);
    }, LOCK_REFRESH_MS);
    refresh.unref();
    return async () => {
      clearInterval(refresh);
      await handle.close().catch(() => undefined);
      const current = await readStateFile(path, MAX_LOCK_BYTES);
      if (typeof current !== "string" && current.text === content) await rm(path, { force: true });
    };
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await createLock(path, content, token);
    if (handle) return held(handle);
    const observed = await readStateFile(path, MAX_LOCK_BYTES);
    if (observed === "missing") continue;
    if (observed === "unusable")
      throw new PublishError(
        "state_file_unsafe",
        `${path} is not a lock Weldall wrote (it is a link, a pipe, a folder or too large), so Weldall stops here. Nothing was published and nothing in the folder changed. If you did not create it yourself, something working in this folder (for example an AI agent) did.`,
        { hint: `Delete ${path}, then try again.`, details: { path } },
      );
    if (!isStale(observed)) throw busy(path);

    const id = createHash("sha256")
      .update(`${observed.stats.dev}:${observed.stats.ino}:${observed.text}`)
      .digest("hex")
      .slice(0, 32);
    const breaker = join(directory, `${LOCK_FILE}.break-${id}`);
    let breaking;
    try {
      breaking = await open(
        breaker,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw busy(path, " (it is taking over a stale lock)");
    }
    await breaking.close();
    try {
      // Still the lock judged stale? Otherwise another run took it over already.
      if (!sameLock(await readStateFile(path, MAX_LOCK_BYTES), observed)) throw busy(path);
      const aside = `${path}.${token}.stale`;
      try {
        await renameWithRetry(path, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = await readStateFile(aside, MAX_LOCK_BYTES);
      if (!sameLock(moved, observed)) {
        // Not the stale lock after all: put it back, never over another one.
        await link(aside, path).catch(() => undefined);
        await rm(aside, { force: true });
        throw busy(path);
      }
      await rm(aside, { force: true });
      // Created while still holding the break file, so no other run sees an empty place.
      const taken = await createLock(path, content, token);
      if (taken) return held(taken);
    } finally {
      await rm(breaker, { force: true });
    }
  }
  throw busy(path);
}
