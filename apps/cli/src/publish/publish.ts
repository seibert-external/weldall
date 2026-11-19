import { randomBytes } from "node:crypto";
import type { ResourceRegistryEntry } from "@weldall/sdk";
import { access, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GIT_APP_SCOPES, selectGitApp, type GitApp, type OpenGitApp } from "../git/git-apps.js";
import {
  configureGitProxyRepository,
  gitProxySettings,
  parseGitProxyRemote,
} from "../git/repository-setup.js";
import {
  allowedChoices,
  hasConflictMarkers,
  type ConflictChoice,
  type ConflictFile,
} from "./conflicts.js";
import { PublishError } from "./errors.js";
import {
  looksBinary,
  MAX_PUBLISH_BYTES,
  MAX_SCANNED_FILE_BYTES,
  tooMuch,
  refusalReason,
  type RefusedFile,
} from "./file-safety.js";
import { Folder, LOCAL_SIDE_REF, REPO_SIDE_REF } from "./folder.js";
import { openGitAppApi, type AppStatus, type GitAppApi } from "./git-app-api.js";
import { assertSettingsScopedTo, parseRecordedRemote, recordedGitApp } from "./git-app-choice.js";
import {
  describeTransferFailure,
  GitCommandError,
  GitRepository,
  isSupportedGitVersion,
  MINIMUM_GIT_VERSION,
  parseGitVersion,
} from "./git.js";
import { defaultPrivateGitRoot, PrivateGitDirectory } from "./private-git.js";
import { assertSafeRepository } from "./repository-safety.js";
import {
  acquirePublishLock,
  clearPendingConflict,
  CONFIG,
  readPendingConflict,
  readState,
  REFS,
  writePendingConflict,
} from "./state.js";

export interface PublishOptions {
  /** The app's local folder (top level of its git repository). */
  directory: string;
  /** Reaches the Git apps Weldall lists for the person (direct: the CLI login). */
  gitApps: OpenGitApp;
  /** "Stand holen": merge the repository's state into the folder and publish nothing. */
  syncOnly?: boolean;
  /**
   * Needed for the first publish only. `gitApp` names the Git app's resource key when Weldall
   * lists more than one; a published folder keeps the Git app it recorded.
   */
  app?: { name?: string; purpose?: string; template?: string; gitApp?: string };
  pullRequest?: { title?: string; body?: string };
  /** On conflict, write the merge result with markers into the folder for the agent. */
  resolve?: boolean;
  /** Per conflicted file, after `resolve`: how it was decided. */
  decisions?: Readonly<Record<string, ConflictChoice>>;
  git?: string;
  environment?: NodeJS.ProcessEnv;
  /** Name of a new publish branch; must start with `weldall/publish-`. */
  branchName?: () => string;
  /** Parent of the CLI's private git directories (default `~/.weldall/git`); tests move it. */
  privateGitRoot?: string;
}

export type PublishOutcome = "published" | "nothing_to_publish" | "synced" | "conflict" | "refused";

export interface PublishNotice {
  code: string;
  message: string;
  paths: string[];
}

export interface PublishResult {
  outcome: PublishOutcome;
  app: { id: string; name: string; repositoryUrl: string } | null;
  pullRequest: { number: number; webUrl: string; branch: string; created: boolean } | null;
  /** The commit pushed by this run; null when nothing was pushed. */
  commit: string | null;
  /** What this run published: the changes of the pushed commit against the repository. */
  files: Array<{ path: string; change: "added" | "modified" | "deleted" }>;
  /** What the folder took over from the repository (new local commit), when it changed. */
  folder: { updated: string[]; removed: string[] };
  notices: PublishNotice[];
  /** From Weldall, e.g. a missing branch rule the administrator should add. */
  warnings: Array<{ code: string; message: string }>;
  links: { preview: string | null; live: string | null };
  conflict: {
    /** True when the merge result with markers is in the folder, waiting for decisions. */
    written: boolean;
    files: Array<ConflictFile & { choices: ConflictChoice[]; decided: boolean }>;
  } | null;
  refused: RefusedFile[] | null;
}

/** Trailer of the published commit: a reference to the app, no personal data. */
export const publishTrailer = (appId: string) => `Weldall-App: ${appId}`;

export const defaultBranchName = () => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `weldall/publish-${stamp}-${randomBytes(3).toString("hex")}`;
};

const SAVE_MESSAGE = "Save local changes before syncing with the app's repository (Weldall)";
const changeName = { A: "added", M: "modified", T: "modified", D: "deleted" } as const;
const readable = (text: string) =>
  text.replaceAll(LOCAL_SIDE_REF, "the local folder").replaceAll(REPO_SIDE_REF, "the repository");

/**
 * Opens the app folder's repository after checking git, that the folder is its top level, and
 * that its own git settings cannot make git start a program (`assertSafeRepository`).
 */
export async function openRepository(
  options: Pick<PublishOptions, "directory" | "git" | "environment" | "privateGitRoot">,
) {
  // Checked first: git started in a missing folder fails like a missing git.
  const folder = await stat(options.directory).catch(() => null);
  if (!folder?.isDirectory())
    throw new PublishError(
      "folder_missing",
      `${options.directory} does not exist or is not a folder. Name the app's folder.`,
    );
  const git = new GitRepository(
    options.git ?? "git",
    options.directory,
    options.environment ?? process.env,
  );
  const version = parseGitVersion(await git.text(["--version"]));
  if (!version || !isSupportedGitVersion(version))
    throw new PublishError(
      "git_too_old",
      `Publishing needs git ${MINIMUM_GIT_VERSION.join(".")} or newer; this git is ${version?.join(".") ?? "unknown"}.`,
    );
  const top = await git.run(["rev-parse", "--show-toplevel"], { allow: [128] });
  if (top.code !== 0)
    throw new PublishError(
      "not_a_repository",
      `${options.directory} is not a git repository. The app folder must be a git repository whose first commit is the template.`,
    );
  const topLevel = top.stdout.toString("utf8").trim();
  if ((await realpath(topLevel)) !== (await realpath(options.directory)))
    throw new PublishError(
      "not_top_level",
      `${options.directory} is inside the git repository ${topLevel}. Publish the app from its top folder.`,
    );
  // Before any command that reads the working tree or writes a ref (so far only `rev-parse`).
  const entries = await assertSafeRepository(git);
  const gitPath = async (path: string) =>
    resolve(options.directory, await git.text(["rev-parse", "--git-path", path]));
  git.usePrivateDirectory(
    new PrivateGitDirectory({
      root: options.privateGitRoot ?? defaultPrivateGitRoot(),
      workTree: options.directory,
      objects: await gitPath("objects"),
      index: await gitPath("index"),
      exclude: await gitPath("info/exclude"),
      entries,
    }),
  );
  return new Folder(git, await git.text(["rev-parse", "--absolute-git-dir"]), entries);
}

/**
 * Invariant for `refs/weldall/base`: it always names a state the folder has actually taken over
 * (the template commit, a fetched or pushed commit after a successful takeover, the conflict's
 * repository state after a verified resolution, or an ancestor of the current base). Merging
 * against a state the folder never had would read the repository's changes as local reverts.
 * `refs/weldall/pr-base` is only a candidate and becomes the base only under that rule.
 *
 * Publishes the folder (or, with `syncOnly`, only brings the repository's state into it). The
 * recipe is the spike's: fetch, merge by content with the last agreed state as base, push the
 * result as one commit on top of the fetched state without force, and only after that let the
 * folder take over the result.
 */
export async function publishApp(options: PublishOptions): Promise<PublishResult> {
  const folder = await openRepository(options);
  try {
    const release = await acquirePublishLock(folder);
    try {
      return await new PublishRun(folder, options).run();
    } finally {
      await release();
    }
  } finally {
    await folder.repository.disposePrivateDirectory();
  }
}

class PublishRun {
  private readonly git: GitRepository;
  /** The Git app's calls, set by `resolveApp` once Weldall's registry named the Git app. */
  private api!: GitAppApi;
  private readonly notices: PublishNotice[] = [];
  private readonly warnings: Array<{ code: string; message: string }> = [];

  constructor(
    private readonly folder: Folder,
    private readonly options: PublishOptions,
  ) {
    this.git = folder.repository;
  }

  private notice(code: string, message: string, paths: string[] = []) {
    this.notices.push({ code, message, paths });
  }

  private result(
    outcome: PublishOutcome,
    app: PublishResult["app"],
    rest: Partial<PublishResult> = {},
  ): PublishResult {
    return {
      outcome,
      app,
      pullRequest: null,
      commit: null,
      files: [],
      folder: { updated: [], removed: [] },
      notices: this.notices,
      warnings: this.warnings,
      links: { preview: null, live: null },
      conflict: null,
      refused: null,
      ...rest,
    };
  }

  async run(): Promise<PublishResult> {
    const { options, git } = this;
    await this.assertNoGitOperation();
    const template = await this.readTemplateAgreement();
    const app = await this.resolveApp(template);
    const appRef = { id: app.id, name: app.name, repositoryUrl: app.repositoryUrl };

    await configureGitProxyRepository({
      directory: options.directory,
      remoteUrl: app.remoteUrl,
      git: git.git,
      environment: git.cleanEnvironment(),
    });

    const resumed = await this.resumeConflict();
    if (resumed) return this.result("conflict", appRef, { conflict: resumed });

    // Where the repository's state comes from, and where a publish goes.
    let prBranch = await readState(git, CONFIG.prBranch);
    const status = await this.api.readStatus(app.id, prBranch ?? undefined);
    let needsPullRequest = false;
    if (prBranch) {
      const pull = status.pullRequest;
      if (!pull) {
        if (status.warnings.some(({ code }) => code.startsWith("pull_requests_")))
          throw new PublishError(
            "pull_request_unknown",
            "Weldall could not read the state of the pull request. Nothing was published; try again later.",
          );
        // Pushed earlier (or about to be, when a run stopped before its push) without a pull request.
        needsPullRequest = true;
      } else if (pull.state === "open") {
        await git.setConfig(CONFIG.prNumber, String(pull.number));
        await git.setConfig(CONFIG.prUrl, pull.webUrl);
      } else {
        await this.leavePullRequest(app.remoteUrl, prBranch, pull);
        prBranch = null;
      }
    }
    // 1. Fetch the repository's state into a private ref (no remote-tracking branch, no tags).
    let sameBranch = prBranch !== null;
    try {
      await this.fetch(app.remoteUrl, prBranch ?? app.defaultBranch, REFS.theirs);
    } catch (error) {
      // A run recorded its branch and stopped before the push: start that branch afresh.
      if (!(
        sameBranch &&
        needsPullRequest &&
        error instanceof PublishError &&
        error.code === "branch_missing"
      ))
        throw error;
      sameBranch = false;
      await this.fetch(app.remoteUrl, app.defaultBranch, REFS.theirs);
    }
    const theirs = (await git.resolve(REFS.theirs))!;
    const theirsTree = await git.treeOf(theirs);
    const base = await this.requireBase();
    const baseTree = await git.treeOf(base);

    // 2. The local side: the folder as it is, with protected paths taken from the repository.
    const protectedPaths = status.publish.protectedPaths;
    const folderTree = await this.folder.snapshotTree();
    const local = await this.folder.replacePaths(folderTree, theirs, protectedPaths);
    const protectedChanges = protectedPaths.length
      ? await this.folder.diff(baseTree, folderTree, protectedPaths)
      : [];
    if (protectedChanges.length)
      this.notice(
        "protected_files_not_published",
        `These files always come from the app's repository (${protectedPaths.join(", ")}), so your local changes to them are not published and the folder gets the repository's version. Your version stays in the folder's local git history.`,
        protectedChanges.map(({ path }) => path),
      );

    // 3. Nothing that looks like a secret or a dump leaves the device.
    if (!options.syncOnly) {
      const refused = await this.refusedFiles(baseTree, local);
      if (refused.length) return this.result("refused", appRef, { refused });
    }

    // 4. Merge by content: base = last agreed state, ours = folder, theirs = repository.
    const merged = await this.folder.merge({ base: baseTree, local, repo: theirsTree });
    if (merged.conflicts.length) {
      const files = merged.conflicts.map((file) => ({
        ...file,
        description: readable(file.description),
      }));
      let written = false;
      if (options.resolve) {
        const saved = await this.folder.saveFolder(SAVE_MESSAGE);
        if (saved.tree !== folderTree)
          throw new PublishError(
            "folder_changed",
            "The folder changed while merging, so the conflict markers were not written. Nothing was published; run publish again.",
          );
        // Stored first: a run stopped while writing restarts cleanly (see resumeConflict).
        await writePendingConflict(this.folder, {
          version: 1,
          base,
          repo: theirs,
          local: saved.commit,
          input: local,
          merge: merged.tree,
          files,
        });
        await this.folder.writeMergeResult(saved.commit, merged.tree);
        written = true;
      }
      return this.result("conflict", appRef, {
        conflict: {
          written,
          files: files.map((file) => ({
            ...file,
            choices: allowedChoices(file.kind),
            decided: false,
          })),
        },
      });
    }

    // 5. Publish: one commit on top of the fetched state, a plain push without force.
    const result = merged.tree;
    let pushed: string | null = null;
    let branch = prBranch;
    const files = options.syncOnly ? [] : await this.folder.diff(theirsTree, result);
    if (!options.syncOnly && result !== theirsTree) {
      const identity = status.publish.commitIdentity;
      if (!identity)
        throw new PublishError(
          "commit_identity_unavailable",
          `Nothing was published: Weldall could not confirm the identity for published commits. ${status.warnings.find(({ code }) => code === "commit_identity_unavailable")?.message ?? "Try again later."}`,
        );
      const title = this.title(app.name, prBranch === null);
      const commit = await this.folder.commitTree(
        result,
        [theirs],
        `${title}\n\n${publishTrailer(app.id)}\n`,
        identity,
      );
      branch ??= (options.branchName ?? defaultBranchName)();
      if (!sameBranch) {
        // Recorded before the push, so a run stopped after it reuses the branch instead of a second one.
        await git.updateRef(REFS.prBase, theirs);
        await git.setConfig(CONFIG.prBranch, branch);
        await git.unsetConfig(CONFIG.prNumber);
        await git.unsetConfig(CONFIG.prUrl);
        needsPullRequest = true;
      }
      await this.transfer(
        "push",
        app.remoteUrl,
        [
          "push",
          "--porcelain",
          "--no-verify",
          "--no-signed",
          app.remoteUrl,
          `${commit}:refs/heads/${branch}`,
        ],
        "write",
      );
      pushed = commit;
    }

    // 6. Only now the folder takes over the result, and the agreed state moves forward.
    const folderChanges = await this.folder.diff(folderTree, result);
    const takeOver = "Take over the state of the app's repository (Weldall)";
    let adopted = await this.folder.adopt(result, folderTree, takeOver, SAVE_MESSAGE);
    if (!adopted.adopted && adopted.edited) {
      // Edited while publishing: bring the newer edits onto the result (base: the folder the
      // merge read). Only a clean merge is taken over; otherwise the folder stays as it is.
      const again = await this.folder.merge({
        base: folderTree,
        local: adopted.savedTree,
        repo: result,
      });
      if (!again.conflicts.length) {
        const retried = await this.folder.adopt(
          again.tree,
          adopted.savedTree,
          takeOver,
          SAVE_MESSAGE,
        );
        if (retried.adopted)
          this.notice(
            "edited_during_publish",
            `Files were edited while ${pushed ? "publishing" : "syncing"}. Those edits are kept in the folder${pushed ? " but were not published; the next publish sends them" : ""}.`,
          );
        adopted = retried;
      }
    }
    if (adopted.adopted) {
      await git.updateRef(REFS.base, pushed ?? theirs);
      const removed = folderChanges
        .filter(({ status: change, path }) => change === "D" && !isBelow(path, protectedPaths))
        .map(({ path }) => path);
      if (removed.length)
        this.notice(
          "removed_by_repository",
          "The app's repository no longer has these files (someone removed them or undid a change there), so they were removed from the folder too. They stay in the folder's local git history.",
          removed,
        );
    } else
      this.notice(
        "folder_not_updated",
        `The folder changed while ${pushed ? "publishing" : "syncing"} (${adopted.reason}), so it did not take over the repository's state and none of your files were changed. ${pushed ? "The state from before your latest edits was published; the" : "The"} next publish brings your latest edits and the repository's state together.`,
      );

    // 7. The pull request, opened by the server; reopening for the same branch is idempotent.
    let pullRequest: PublishResult["pullRequest"] = null;
    if (!options.syncOnly && branch && needsPullRequest) {
      let opened;
      try {
        opened = await this.api.openPullRequest(app.id, {
          head: branch,
          title: this.title(app.name, true),
          body: options.pullRequest?.body ?? "",
        });
      } catch (error) {
        if (!(error instanceof PublishError) || !pushed) throw error;
        // The change was sent: a fixed code, so an agent does not read this as "nothing published".
        throw new PublishError(
          "pull_request_not_opened",
          `Commit ${pushed} was pushed to branch ${branch}, but opening its pull request failed: ${error.message} Run publish again to open it; nothing is pushed twice.`,
          {
            cause: error,
            hint:
              error.hint ?? "Run publish again to open the pull request; nothing is pushed twice.",
            details: { commit: pushed, branch, cause: error.code },
          },
        );
      }
      await git.setConfig(CONFIG.prNumber, String(opened.pullRequest.number));
      await git.setConfig(CONFIG.prUrl, opened.pullRequest.webUrl);
      this.warnings.push(...opened.warnings);
      pullRequest = {
        number: opened.pullRequest.number,
        webUrl: opened.pullRequest.webUrl,
        branch,
        created: opened.created,
      };
    } else if (!options.syncOnly && branch) {
      const number = await git.config(CONFIG.prNumber);
      const webUrl = await git.config(CONFIG.prUrl);
      if (number && webUrl)
        pullRequest = { number: Number(number), webUrl, branch, created: false };
    }

    const links = await this.links(app.id, branch);
    const outcome: PublishOutcome = options.syncOnly
      ? "synced"
      : pushed || pullRequest?.created
        ? "published"
        : "nothing_to_publish";
    return this.result(outcome, appRef, {
      pullRequest,
      commit: pushed,
      files: files.map(({ status: change, path }) => ({ path, change: changeName[change] })),
      folder: adopted.adopted
        ? {
            updated: folderChanges.filter(({ status: s }) => s !== "D").map(({ path }) => path),
            removed: folderChanges.filter(({ status: s }) => s === "D").map(({ path }) => path),
          }
        : { updated: [], removed: [] },
      links,
    });
  }

  private title(appName: string, forPullRequest: boolean) {
    const title = this.options.pullRequest?.title?.trim();
    if (title) return title.slice(0, 200);
    return forPullRequest ? `Publish ${appName}` : `Update ${appName}`;
  }

  private async assertNoGitOperation() {
    for (const name of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]) {
      const exists = await access(join(this.folder.gitDirectory, name)).then(
        () => true,
        () => false,
      );
      if (exists)
        throw new PublishError(
          "git_operation_in_progress",
          `A git operation is in progress in this folder (${name}). Finish or abort it first (for example \`git merge --abort\`).`,
        );
    }
  }

  /** The agreement with INV-185: first commit = template state, template name and commit recorded. */
  private async readTemplateAgreement() {
    const { git } = this;
    const head = await git.resolve("HEAD");
    if (!head)
      throw new PublishError(
        "template_missing",
        "The folder has no commit. Its first commit must be the template state.",
      );
    const recorded = await readState(git, CONFIG.templateCommit);
    const name = await git.config(CONFIG.template);
    const missing = [
      ...(recorded ? [] : [`${CONFIG.templateCommit} (the commit that holds the template state)`]),
      ...(name || this.options.app?.template ? [] : [`${CONFIG.template} (the template's name)`]),
    ];
    if (missing.length)
      throw new PublishError(
        "template_missing",
        `The folder does not record where it came from. Missing in its git config: ${missing.join("; ")}. Publish does not guess a starting point.`,
        {
          hint: `Set them with \`git config ${CONFIG.template} <name>\` and \`git config ${CONFIG.templateCommit} <first commit>\`.`,
        },
      );
    const commit = await git.resolve(recorded!);
    if (!commit)
      throw new PublishError(
        "template_missing",
        `${CONFIG.templateCommit} names ${recorded}, which is not a commit in this folder.`,
      );
    const parents = (await git.text(["rev-list", "--parents", "-n", "1", commit])).split(" ");
    if (parents.length !== 1)
      throw new PublishError(
        "template_missing",
        `${CONFIG.templateCommit} must be the folder's first commit (the template state), but ${commit} has a parent.`,
      );
    if (!(await git.isAncestor(commit, head)))
      throw new PublishError(
        "template_missing",
        `The template commit ${commit} is not part of the folder's history (HEAD ${head}).`,
      );
    const option = this.options.app?.template;
    if (option && name && option !== name)
      throw new PublishError(
        "template_mismatch",
        `The folder was made from template "${name}", not "${option}".`,
      );
    return { name: option ?? name!, commit };
  }

  private async checkRemote(remoteUrl: string | null) {
    const current = await this.git.config("remote.weldall.url");
    if (current === null) return;
    let proxy = true;
    try {
      parseGitProxyRemote(current);
    } catch {
      proxy = false;
    }
    if (!proxy || (remoteUrl !== null && current !== remoteUrl))
      throw new PublishError(
        "remote_conflict",
        `The folder already has a git remote named "weldall" (${printable(current)}) that is not this app's git URL. Publish does not overwrite it; rename or remove it (\`git remote rename weldall <other>\`), then publish again.`,
      );
  }

  /** Opens the Git app, refusing a folder whose settings name another address than its `/git/`. */
  private async openGitApp(choose: (resources: ResourceRegistryEntry[]) => GitApp) {
    this.api = await openGitAppApi(this.options.gitApps, choose);
    assertSettingsScopedTo(this.folder.configEntries, this.api.gitApp);
  }

  /** A git URL the Git app returned must lie below its own origin's `/git/`, like a stored one. */
  private trustedRemote(remoteUrl: string): string {
    const { gitApp } = this.api;
    let origin: string | null = null;
    try {
      origin = parseGitProxyRemote(remoteUrl).origin;
    } catch {
      // Reported below.
    }
    if (origin !== gitApp.origin)
      throw new PublishError(
        "remote_untrusted",
        `The Git app ${gitApp.name} returned a git URL (${printable(remoteUrl)}) that is not below its own address ${gitApp.origin}/git/, so Weldall does not use it. Nothing was published.`,
        {
          hint: "Ask your Weldall administrator to check the Git app's registration and its public origin.",
        },
      );
    return remoteUrl;
  }

  private async resolveApp(template: { name: string; commit: string }) {
    const { git, options } = this;
    const id = await readState(git, CONFIG.appId);
    if (id) {
      const remoteUrl = await git.config(CONFIG.remoteUrl);
      const key = await readState(git, CONFIG.gitApp);
      const defaultBranch = await readState(git, CONFIG.defaultBranch);
      if (!remoteUrl || !defaultBranch || !key)
        throw new PublishError(
          "state_incomplete",
          `The folder records app ${id} but not its Git app, git URL or default branch (${CONFIG.gitApp}, ${CONFIG.remoteUrl}, ${CONFIG.defaultBranch}).`,
        );
      // Before Weldall is asked: a folder with these settings is refused whatever it says.
      parseRecordedRemote(remoteUrl);
      await this.checkRemote(remoteUrl);
      await this.requireBase();
      await this.openGitApp((resources) =>
        recordedGitApp(resources, { key, remoteUrl, explicit: options.app?.gitApp }),
      );
      return {
        id,
        name: (await git.config(CONFIG.appName)) ?? id,
        remoteUrl,
        defaultBranch,
        repositoryUrl: (await git.config(CONFIG.repositoryUrl)) ?? "",
      };
    }

    if (options.syncOnly)
      throw new PublishError(
        "not_published",
        "This folder has not been published yet, so there is no repository state to fetch.",
      );
    const name = options.app?.name?.trim();
    const purpose = options.app?.purpose?.trim();
    if (!name || !purpose)
      throw new PublishError(
        "app_details_missing",
        `The first publish creates the app. Missing: ${[name ? null : "--name", purpose ? null : "--purpose"].filter(Boolean).join(", ")}.`,
      );
    await this.checkRemote(null);
    const base = await git.resolve(REFS.base);
    if (base && base !== template.commit)
      throw new PublishError(
        "state_incomplete",
        `${REFS.base} exists but no app is recorded. Publish does not guess which state is agreed with a repository.`,
      );

    await this.openGitApp((resources) =>
      selectGitApp(resources, { key: options.app?.gitApp, scope: GIT_APP_SCOPES.publish }),
    );
    const created = await this.api.createApp({ template: template.name, name, purpose });
    const remoteUrl = this.trustedRemote(created.git.remoteUrl);
    await this.checkRemote(remoteUrl);
    this.warnings.push(...created.warnings);
    if (!base) await git.updateRef(REFS.base, template.commit);
    await git.setConfig(CONFIG.appId, created.app.id);
    await git.setConfig(CONFIG.appName, created.app.name);
    await git.setConfig(CONFIG.gitApp, this.api.gitApp.key);
    await git.setConfig(CONFIG.remoteUrl, remoteUrl);
    await git.setConfig(CONFIG.defaultBranch, created.repository.defaultBranch);
    await git.setConfig(CONFIG.repositoryUrl, created.repository.webUrl);
    if (!(await git.config(CONFIG.template))) await git.setConfig(CONFIG.template, template.name);
    return {
      id: created.app.id,
      name: created.app.name,
      remoteUrl,
      defaultBranch: created.repository.defaultBranch,
      repositoryUrl: created.repository.webUrl,
    };
  }

  private async requireBase(): Promise<string> {
    const base = await this.git.resolve(REFS.base);
    if (!base)
      throw new PublishError(
        "base_missing",
        `The folder lost its record of the state last agreed with the app's repository (${REFS.base}). Publish does not guess it, because a wrong guess can undo other people's changes. Nothing was published.`,
        {
          hint: "Restore the ref from a backup of the folder, or ask for help to start a fresh folder from the app's repository.",
        },
      );
    return base;
  }

  /** The current pull request was merged or closed: decide the base for the next one. */
  private async leavePullRequest(
    remoteUrl: string,
    branch: string,
    pull: NonNullable<AppStatus["pullRequest"]>,
  ): Promise<void> {
    const { git } = this;
    const base = await this.requireBase();
    let fallback = pull.state === "closed";
    if (pull.state === "merged") {
      // The race: a push may land after the merge. Only a base inside the merged head is safe.
      if (!(await git.resolve(pull.headCommit))) {
        try {
          await this.fetch(remoteUrl, branch, REFS.prHead);
        } catch (error) {
          if (!(error instanceof PublishError && error.code === "branch_missing")) throw error;
        }
      }
      fallback =
        !(await git.resolve(pull.headCommit)) || !(await git.isAncestor(base, pull.headCommit));
      if (fallback)
        this.notice(
          "merged_without_last_publish",
          `Pull request #${pull.number} was merged without the last published change. Your changes since the state the pull request started from are offered again.`,
        );
    } else
      this.notice(
        "pull_request_closed",
        `Pull request #${pull.number} was closed without merging. Its changes are offered again in a new pull request.`,
      );
    if (fallback) {
      const prBase = await git.resolve(REFS.prBase);
      if (!prBase)
        throw new PublishError(
          "base_missing",
          `The folder lost the state pull request #${pull.number} started from (${REFS.prBase}). Publish does not guess it.`,
        );
      // Invariant: the base is always a state the folder has taken over. Falling back is only
      // right when the folder took over a state built on the pull request's start; when the
      // takeover after the push was refused, the base is older and already offers the changes
      // again, while pr-base would make the repository's newer changes look like local reverts.
      if (await git.isAncestor(prBase, base)) await git.updateRef(REFS.base, prBase, base);
    }
    await git.unsetConfig(CONFIG.prBranch);
    await git.unsetConfig(CONFIG.prNumber);
    await git.unsetConfig(CONFIG.prUrl);
    await git.deleteRef(REFS.prHead);
  }

  /**
   * Continues after `resolve`. The base moves to the conflict's repository state only when the
   * folder verifiably builds on the written merge result: HEAD still descends from the saved
   * folder, and no change the merge brought in from the repository was undone. Otherwise the
   * resolution was discarded, and the merge starts over from the old base, so no change in the
   * repository is reverted. Returns the conflict when decisions are still missing.
   */
  private async resumeConflict(): Promise<PublishResult["conflict"] | null> {
    const { git, folder, options } = this;
    const decisions = options.decisions ?? {};
    const pending = await readPendingConflict(folder);
    if (!pending) {
      if (Object.keys(decisions).length)
        throw new PublishError(
          "no_conflict",
          "There is no conflict resolution in progress, so there is nothing to decide. Publish with --resolve first.",
        );
      return null;
    }
    const base = await this.requireBase();
    const folderTree = await folder.snapshotTree();
    const conflicted = new Set(pending.files.map(({ path }) => path));
    const savedTree = await git.treeOf(pending.local);
    const brought = (await folder.diff(savedTree, pending.merge)).filter(
      ({ path }) => !conflicted.has(path),
    );
    const kept = new Set((await folder.diff(savedTree, folderTree)).map(({ path }) => path));
    const undone = brought.filter(({ path }) => !kept.has(path)).map(({ path }) => path);
    const buildsOnMerge =
      base === pending.base && (await git.isAncestor(pending.local, "HEAD")) && !undone.length;
    if (!buildsOnMerge) {
      await clearPendingConflict(folder);
      this.notice(
        "resolution_discarded",
        "The folder no longer contains the repository's changes from the conflict resolution (it was reset or rewritten), so the merge starts over from the last agreed state. No repository change is undone.",
        undone,
      );
      return null;
    }

    const unknown = Object.keys(decisions).filter((path) => !conflicted.has(path));
    if (unknown.length)
      throw new PublishError(
        "invalid_decision",
        `These files are not part of the conflict: ${unknown.join(", ")}.`,
      );
    const files = pending.files.map((file) => ({
      ...file,
      choices: allowedChoices(file.kind),
      decided: decisions[file.path] !== undefined,
    }));
    for (const file of files) {
      const choice = decisions[file.path];
      if (choice !== undefined && !file.choices.includes(choice))
        throw new PublishError(
          "invalid_decision",
          `${file.path} is a ${file.kind} conflict; decide it with one of: ${file.choices.join(", ")}.`,
        );
    }
    if (files.some(({ decided }) => !decided)) return { written: true, files };

    const markers: string[] = [];
    const entries = await folder.entries(folderTree);
    const keptAsIs = pending.files.filter(
      ({ path, kind }) => decisions[path] === "folder" && kind === "content" && entries.has(path),
    );
    const blobs = await folder.readBlobs(keptAsIs.map(({ path }) => entries.get(path)!.object));
    for (const { path } of keptAsIs) {
      const blob = blobs.get(entries.get(path)!.object);
      if (blob && !looksBinary(blob) && hasConflictMarkers(blob.toString("utf8")))
        markers.push(path);
    }
    if (markers.length)
      throw new PublishError(
        "conflict_markers_left",
        `These files still contain conflict markers: ${markers.join(", ")}. Resolve them, or decide them with local or repo.`,
      );

    const repoTree = await git.treeOf(pending.repo);
    const resolved = await folder.setPaths(
      folderTree,
      pending.files
        .filter(({ path }) => decisions[path] !== "folder")
        .map(({ path }) => ({
          path,
          from: decisions[path] === "local" ? pending.input : repoTree,
        })),
    );
    const adopted = await folder.adopt(
      resolved,
      folderTree,
      "Resolve conflicts with the app's repository (Weldall)",
      "Save the conflict resolution (Weldall)",
    );
    if (!adopted.adopted)
      throw new PublishError(
        "folder_changed",
        `The folder changed while applying the decisions (${adopted.reason}). Run publish again.`,
      );
    await git.updateRef(REFS.base, pending.repo, base);
    await clearPendingConflict(folder);
    this.notice(
      "conflict_resolved",
      "The conflict resolution was taken over; publishing continues from it.",
      pending.files.map(({ path }) => path),
    );
    return null;
  }

  private async refusedFiles(baseTree: string, local: string): Promise<RefusedFile[]> {
    const changes = (await this.folder.diff(baseTree, local)).filter(
      ({ status }) => status !== "D",
    );
    if (!changes.length) return [];
    const entries = await this.folder.entries(local);
    const inBase = await this.folder.entries(baseTree);
    const candidates = changes
      .map(({ path }) => ({ path, entry: entries.get(path) }))
      .filter(
        (item): item is { path: string; entry: NonNullable<typeof item.entry> } =>
          item.entry !== undefined,
      );
    const total = candidates.reduce((sum, { entry }) => sum + (entry.size ?? 0), 0);
    if (total > MAX_PUBLISH_BYTES)
      throw tooMuch(candidates.map(({ path, entry }) => ({ path, size: entry.size ?? 0 })));
    const small = candidates.filter(
      ({ entry }) =>
        entry.mode !== "160000" && entry.size !== null && entry.size <= MAX_SCANNED_FILE_BYTES,
    );
    const blobs = await this.folder.readBlobs(small.map(({ entry }) => entry.object));
    const refused: RefusedFile[] = [];
    for (const { path, entry } of candidates) {
      const blob = blobs.get(entry.object);
      const reason = refusalReason({
        path,
        mode: entry.mode,
        inBase: inBase.has(path),
        size: entry.size ?? 0,
        text:
          blob && (entry.mode === "120000" || !looksBinary(blob)) ? blob.toString("utf8") : null,
      });
      if (reason) refused.push({ path, reason });
    }
    return refused;
  }

  /**
   * Fetches into the private git directory, then sets `ref` in the folder. The private directory
   * has no refs of the folder, so the states the folder already has are named as negotiation
   * tips; otherwise every fetch would download the whole history.
   */
  private async fetch(remoteUrl: string, branch: string, ref: string) {
    const { git } = this;
    const tips = new Set<string>();
    for (const known of [REFS.base, REFS.theirs, REFS.prBase, "HEAD"]) {
      const commit = await git.resolve(known);
      if (commit) tips.add(commit);
    }
    await this.transfer("fetch", remoteUrl, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      ...[...tips].map((tip) => `--negotiation-tip=${tip}`),
      remoteUrl,
      `+refs/heads/${branch}:${ref}`,
    ]);
    const fetched = await git.text(["rev-parse", "--verify", `${ref}^{commit}`], {
      isolated: true,
    });
    await git.updateRef(ref, fetched);
  }

  /**
   * Fetch and push run in the private git directory with the proxy settings on the command
   * line: the folder's config, which an agent may change meanwhile, cannot add a credential
   * helper, a URL rewrite or a remote setting.
   */
  private async transfer(
    operation: "fetch" | "push",
    remoteUrl: string,
    args: string[],
    access: "read" | "write" = "read",
  ) {
    try {
      await this.git.run(args, {
        network: true,
        access,
        isolated: true,
        config: gitProxySettings(remoteUrl),
      });
    } catch (error) {
      if (error instanceof GitCommandError) throw describeTransferFailure(operation, error);
      throw error;
    }
  }

  /** Preview and live links once the CI reported them; the publish stands without them. */
  private async links(appId: string, branch: string | null) {
    try {
      const status = await this.api.readStatus(appId, branch ?? undefined);
      for (const item of status.warnings)
        if (!this.warnings.some(({ code }) => code === item.code)) this.warnings.push(item);
      return status.links;
    } catch {
      return { preview: null, live: null };
    }
  }
}

/** Values from the folder or a server, shown bounded and without control characters. */
const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);

const isBelow = (path: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
