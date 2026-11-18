import { randomBytes } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_PUBLISH_BYTES, tooMuch } from "./file-safety.js";
import { GitCommandError, type GitRepository } from "./git.js";
import { PublishError } from "./errors.js";
import { parseMergeTree, type MergeOutcome } from "./conflicts.js";

/** Identity for the commits publish makes in the local folder only; they are never pushed. */
const LOCAL_FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: "Weldall",
  GIT_AUTHOR_EMAIL: "weldall@localhost.invalid",
  GIT_COMMITTER_NAME: "Weldall",
  GIT_COMMITTER_EMAIL: "weldall@localhost.invalid",
};

/** Throwaway refs that name the merge sides, so conflict markers read `refs/weldall/local` and `refs/weldall/repo`. */
export const LOCAL_SIDE_REF = "refs/weldall/local";
export const REPO_SIDE_REF = "refs/weldall/repo";

export interface TreeChange {
  /** A added, M modified, D deleted, T type changed (e.g. file to symlink). */
  status: "A" | "M" | "D" | "T";
  path: string;
}

export interface TreeEntry {
  mode: string;
  object: string;
  size: number | null;
}

/**
 * Operations on the local folder's repository that never lose work: trees are built in a
 * private index, the person's index and working tree change only in {@link Folder.adopt} and
 * {@link Folder.writeMergeResult}, and git itself refuses to overwrite a file that changed.
 */
export class Folder {
  private localIdentity: NodeJS.ProcessEnv | undefined;

  constructor(
    readonly repository: GitRepository,
    readonly gitDirectory: string,
  ) {}

  /** Directory for publish's own files inside `.git`. */
  get stateDirectory() {
    return join(this.gitDirectory, "weldall");
  }

  private async identity(): Promise<NodeJS.ProcessEnv> {
    if (this.localIdentity) return this.localIdentity;
    const probe = await this.repository.run(["var", "GIT_COMMITTER_IDENT"], { allow: [128] });
    this.localIdentity = probe.code === 0 ? {} : LOCAL_FALLBACK_IDENTITY;
    return this.localIdentity;
  }

  /**
   * Runs `work` with a private, temporary index. Every command inside runs `isolated`: they
   * read the working tree or name objects only by hash.
   */
  private async withIndex<T>(work: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    await mkdir(this.stateDirectory, { recursive: true });
    const index = join(this.stateDirectory, `index-${randomBytes(6).toString("hex")}`);
    try {
      return await work({ GIT_INDEX_FILE: index });
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  /**
   * The folder's current content as a tree: HEAD plus every change, deleted files and untracked
   * files that `.gitignore` does not exclude. The person's index is not touched.
   */
  async snapshotTree(): Promise<string> {
    await this.assertUntrackedSize();
    const head = await this.repository.text(["rev-parse", "--verify", "HEAD^{commit}"]);
    return this.withIndex(async (env) => {
      await this.repository.run(["read-tree", head], { env, isolated: true });
      try {
        await this.repository.run(["add", "-A", "--", "."], { env, isolated: true });
      } catch (error) {
        const nested =
          error instanceof GitCommandError
            ? /'([^']+)' does not have a commit checked out/.exec(error.output.stderr)?.[1]
            : undefined;
        if (nested === undefined) throw error;
        throw new PublishError(
          "nested_repository",
          `${nested} is a folder with its own git repository (a nested .git folder). Its files cannot be published that way. Delete ${nested}.git, or add the folder to .gitignore, then try again.`,
        );
      }
      return this.repository.text(["write-tree"], { env, isolated: true });
    });
  }

  async commitTree(
    tree: string,
    parents: string[],
    message: string,
    identity?: { name: string; email: string },
  ): Promise<string> {
    const env = identity
      ? {
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
        }
      : await this.identity();
    return this.repository.text(
      ["commit-tree", "--no-gpg-sign", ...parents.flatMap((parent) => ["-p", parent]), tree],
      { env, input: message },
    );
  }

  /** `tree` with every path below `paths` replaced by its version in `source` (or removed). */
  async replacePaths(tree: string, source: string, paths: readonly string[]): Promise<string> {
    if (!paths.length) return tree;
    return this.withIndex(async (env) => {
      await this.repository.run(["read-tree", tree], { env, isolated: true });
      await this.repository.run(
        ["--literal-pathspecs", "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...paths],
        { env, isolated: true },
      );
      const entries = await this.repository.run([
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        source,
        "--",
        ...paths,
      ]);
      if (entries.stdout.length)
        await this.repository.run(["update-index", "-z", "--index-info"], {
          env,
          isolated: true,
          input: entries.stdout,
        });
      return this.repository.text(["write-tree"], { env, isolated: true });
    });
  }

  /** `tree` with each path set to its version in `from` (a tree), or removed when `from` lacks it. */
  async setPaths(
    tree: string,
    changes: ReadonlyArray<{ path: string; from: string }>,
  ): Promise<string> {
    if (!changes.length) return tree;
    return this.withIndex(async (env) => {
      await this.repository.run(["read-tree", tree], { env, isolated: true });
      for (const { path, from } of changes) {
        const entry = await this.entry(from, path);
        if (entry)
          await this.repository.run(
            ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.object},${path}`],
            { env, isolated: true },
          );
        else
          await this.repository.run(["update-index", "--force-remove", "--", path], {
            env,
            isolated: true,
          });
      }
      return this.repository.text(["write-tree"], { env, isolated: true });
    });
  }

  /** The blob entry at `path` in `tree`, or null. */
  async entry(tree: string, path: string): Promise<TreeEntry | null> {
    const listed = await this.repository.run([
      "ls-tree",
      "-z",
      "-l",
      "--full-tree",
      tree,
      "--",
      path,
    ]);
    for (const record of listed.stdout.toString("utf8").split("\0")) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]+)$/.exec(record);
      if (match && match[5] === path && match[2] !== "tree")
        return {
          mode: match[1]!,
          object: match[3]!,
          size: match[4] === "-" ? null : Number(match[4]),
        };
    }
    return null;
  }

  /** Every blob in `tree` by path, with its size. */
  async entries(tree: string): Promise<Map<string, TreeEntry>> {
    const listed = await this.repository.run(["ls-tree", "-r", "-z", "-l", "--full-tree", tree]);
    const result = new Map<string, TreeEntry>();
    for (const record of listed.stdout.toString("utf8").split("\0")) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]+)$/.exec(record);
      if (match)
        result.set(match[5]!, {
          mode: match[1]!,
          object: match[3]!,
          size: match[4] === "-" ? null : Number(match[4]),
        });
    }
    return result;
  }

  /** Paths that differ between two trees, without rename detection. */
  async diff(from: string, to: string, paths: readonly string[] = []): Promise<TreeChange[]> {
    if (from === to) return [];
    const output = await this.repository.run([
      "--literal-pathspecs",
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--name-status",
      from,
      to,
      ...(paths.length ? ["--", ...paths] : []),
    ]);
    const tokens = output.stdout.toString("utf8").split("\0");
    const changes: TreeChange[] = [];
    for (let index = 0; index + 1 < tokens.length; index += 2) {
      const status = tokens[index]!;
      if (status === "A" || status === "M" || status === "D" || status === "T")
        changes.push({ status, path: tokens[index + 1]! });
    }
    return changes;
  }

  /** Reads blobs in one `git cat-file --batch` call. */
  /**
   * Stops before `git add` copies a huge amount of untracked files (an unignored `node_modules`
   * or `.venv`) into the repository; one publish cannot send it anyway.
   */
  private async assertUntrackedSize() {
    const listed = await this.repository.run(["ls-files", "-z", "--others", "--exclude-standard"], {
      isolated: true,
    });
    const files: Array<{ path: string; size: number }> = [];
    let total = 0;
    for (const path of listed.stdout.toString("utf8").split("\0")) {
      if (!path) continue;
      const size = await lstat(join(this.repository.directory, path)).then(
        (stats) => (stats.isFile() ? stats.size : 0),
        () => 0,
      );
      total += size;
      files.push({ path, size });
    }
    if (total > MAX_PUBLISH_BYTES) throw tooMuch(files);
  }

  /** Reads blobs with `git cat-file --batch`, in chunks that bound the output. */
  async readBlobs(objects: readonly string[]): Promise<Map<string, Buffer>> {
    const result = new Map<string, Buffer>();
    for (let start = 0; start < objects.length; start += 64)
      for (const [object, blob] of await this.readBlobChunk(objects.slice(start, start + 64)))
        result.set(object, blob);
    return result;
  }

  private async readBlobChunk(objects: readonly string[]): Promise<Map<string, Buffer>> {
    const result = new Map<string, Buffer>();
    if (!objects.length) return result;
    const output = (
      await this.repository.run(["cat-file", "--batch"], { input: `${objects.join("\n")}\n` })
    ).stdout;
    let offset = 0;
    while (offset < output.length) {
      const end = output.indexOf(10, offset);
      if (end === -1) break;
      const [object, type, size] = output.subarray(offset, end).toString("utf8").split(" ");
      offset = end + 1;
      if (type === "missing" || size === undefined) continue;
      const length = Number(size);
      result.set(object!, output.subarray(offset, offset + length));
      offset += length + 1;
    }
    return result;
  }

  /**
   * Three-way merge by content of `base`, `local` and `repo` trees, as proven in the spike with
   * Git 2.39: three throwaway commits that share the base as their only parent, then
   * `merge-tree --write-tree`. Touches neither the index nor the working tree. Isolated, with
   * the side refs in the private directory: `.gitattributes` can name merge drivers.
   */
  async merge({
    base,
    local,
    repo,
  }: {
    base: string;
    local: string;
    repo: string;
  }): Promise<MergeOutcome> {
    const baseCommit = await this.commitTree(base, [], "base");
    const localCommit = await this.commitTree(local, [baseCommit], "local");
    const repoCommit = await this.commitTree(repo, [baseCommit], "repo");
    const isolated = { isolated: true };
    await this.repository.updateRef(LOCAL_SIDE_REF, localCommit, undefined, isolated);
    await this.repository.updateRef(REPO_SIDE_REF, repoCommit, undefined, isolated);
    try {
      const result = await this.repository.run(
        ["merge-tree", "--write-tree", "-z", "--messages", LOCAL_SIDE_REF, REPO_SIDE_REF],
        { allow: [1], isolated: true },
      );
      try {
        return parseMergeTree(result.stdout.toString("utf8"), result.code === 0);
      } catch (error) {
        throw new PublishError(
          "merge_failed",
          `Merging failed: ${result.stderr.trim() || String(error)}`,
        );
      }
    } finally {
      await this.repository.deleteRef(LOCAL_SIDE_REF, isolated);
      await this.repository.deleteRef(REPO_SIDE_REF, isolated);
    }
  }

  /**
   * Saves the folder as a local commit on top of HEAD (when it has changes) and resets the
   * person's index to it, so the folder is clean against HEAD. Returns that commit.
   */
  async saveFolder(message: string): Promise<{ commit: string; tree: string }> {
    const head = await this.repository.text(["rev-parse", "--verify", "HEAD^{commit}"]);
    const tree = await this.snapshotTree();
    let commit = head;
    if (tree !== (await this.repository.treeOf(head))) {
      commit = await this.commitTree(tree, [head], message);
      await this.repository.updateRef("HEAD", commit, head);
    }
    await this.repository.run(["read-tree", commit], { isolated: true });
    // A refresh compares file contents, which runs clean filters.
    await this.repository.run(["update-index", "-q", "--refresh"], { allow: [1], isolated: true });
    return { commit, tree };
  }

  /**
   * Brings the folder to `target`: saves it (see {@link saveFolder}), then moves HEAD by one
   * local commit and updates the working tree. Git refuses instead of overwriting a file that
   * changed since the save or an untracked file in the way; then nothing changes and the result
   * says why.
   */
  async adopt(
    target: string,
    mergedFrom: string,
    message: string,
    saveMessage: string,
  ): Promise<
    | { adopted: true; saved: string }
    | { adopted: false; saved: string; savedTree: string; edited: boolean; reason: string }
  > {
    const saved = await this.saveFolder(saveMessage);
    if (saved.tree === target) return { adopted: true, saved: saved.commit };
    // Edits made after the merge read the folder are not in `target`; moving there would undo them.
    if (saved.tree !== mergedFrom)
      return {
        adopted: false,
        saved: saved.commit,
        savedTree: saved.tree,
        edited: true,
        reason: "files were edited meanwhile",
      };
    const next = await this.commitTree(target, [saved.commit], message);
    const update = await this.repository.run(["read-tree", "-m", "-u", saved.commit, next], {
      allow: [128],
      isolated: true,
    });
    if (update.code !== 0)
      return {
        adopted: false,
        saved: saved.commit,
        savedTree: saved.tree,
        edited: false,
        reason: update.stderr.trim().split("\n")[0] ?? "",
      };
    await this.repository.updateRef("HEAD", next, saved.commit);
    return { adopted: true, saved: saved.commit };
  }

  /**
   * Writes a merge result with conflict markers into the working tree while HEAD and the index
   * stay at the saved folder, so the result shows as changes against it.
   */
  async writeMergeResult(saved: string, tree: string): Promise<void> {
    const update = await this.repository.run(["read-tree", "-m", "-u", saved, tree], {
      allow: [128],
      isolated: true,
    });
    if (update.code !== 0)
      throw new PublishError(
        "folder_changed",
        `The folder changed while publishing, so the conflict markers were not written: ${update.stderr.trim().split("\n")[0] ?? ""}. Run publish again.`,
      );
    await this.repository.run(["read-tree", saved], { isolated: true });
    await this.repository.run(["update-index", "-q", "--refresh"], { allow: [1], isolated: true });
  }
}
