import { spawn } from "node:child_process";
import { GIT_HARDENING_ENVIRONMENT, GIT_HARDENING_OPTIONS } from "../git/hardening.js";
import { gitProxyEnvironment } from "../git/repository-setup.js";
import type { GitAccess } from "../git/credential-helper.js";
import { PublishError } from "./errors.js";
import type { PrivateGitDirectory } from "./private-git.js";

/**
 * Oldest git the publish step accepts. The recipe needs `git merge-tree --write-tree` with `-z`
 * conflict records (`--merge-base` arrived only in 2.40, so it builds throwaway commits instead).
 * Verified with Apple Git 2.39.3, the git macOS ships.
 */
export const MINIMUM_GIT_VERSION = [2, 39, 0] as const;

/** Transfer failures after which one repeat is safe: fetches, and pushes of a fixed commit. */
export const REPEATABLE_TRANSFER_CODES: ReadonlySet<string> = new Set([
  "rate_limit",
  "git_route_busy",
]);
/** How long a transfer waits before its one repeat; the git route's own `Retry-After` is a few seconds. */
export const TRANSFER_RETRY_DELAY_MS = 5_000;

const LOCAL_TIMEOUT_MS = 120_000;
const NETWORK_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Variables that would point git at another repository, index, or object store. */
const REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

export interface GitOutput {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitRunOptions {
  /** Sent on stdin. */
  input?: string | Buffer;
  /** Exit codes that are not failures (e.g. 1 for a merge with conflicts). */
  allow?: readonly number[];
  /** Credential access for commands that reach the git proxy; local commands use `read`. */
  access?: GitAccess;
  network?: boolean;
  /** Extra variables, e.g. a temporary index or a commit identity. */
  env?: NodeJS.ProcessEnv;
  /**
   * Runs against the private git directory (see `PrivateGitDirectory`): required for every
   * command that reads or writes the working tree, merges, fetches or pushes.
   */
  isolated?: boolean;
  /** `-c key=value` settings for this command, after the hardening options. */
  config?: ReadonlyArray<readonly [string, string]>;
}

/** A full git object id (SHA-1 or SHA-256) as git prints it. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Hides the Weldall git credential should git ever echo one (it does not by design). */
export const redactGitText = (text: string) =>
  text.replace(/\bwgc_[A-Za-z0-9_.~+/=-]+/g, "<TOKEN_REDACTED>");

/**
 * Every value that names a revision, ref or config key goes after `--end-of-options` (git 2.24 and
 * newer; publish needs 2.39), so a value from the folder can never be read as an option such as
 * `--output=<file>`.
 *
 * Runs git in one repository, one command at a time: the credential helper shares the CLI's
 * session lock, so parallel git processes could block each other. Every call is non-interactive
 * (`gitProxyEnvironment`), in the C locale, so messages can be recognised, and starts with
 * `GIT_HARDENING_OPTIONS`, so the folder's hooks and fsmonitor never run. Commands that the
 * folder's config could make start a program run `isolated`. The others (rev-parse, config,
 * var, commit-tree with `--no-gpg-sign`, update-ref, ls-tree, diff-tree without content,
 * cat-file without filters) run no filter, driver or signer; a missing object can still make
 * them start a lazy fetch from a promisor remote in that config, which the hardening options
 * limit to HTTPS without hooks, credential helpers or an alternates refs command.
 */
export class GitRepository {
  private privateDirectory: PrivateGitDirectory | null = null;

  constructor(
    readonly git: string,
    readonly directory: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  /** The environment without variables that point git at another repository. */
  cleanEnvironment(): NodeJS.ProcessEnv {
    const base = { ...this.environment };
    for (const name of REPOSITORY_VARIABLES) delete base[name];
    return base;
  }

  private env(access: GitAccess, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const base = this.cleanEnvironment();
    return {
      ...gitProxyEnvironment({ access, base }),
      ...GIT_HARDENING_ENVIRONMENT,
      LC_ALL: "C",
      LANGUAGE: "C",
      ...extra,
    };
  }

  /** Set once the folder's config passed `assertSafeRepository`. */
  usePrivateDirectory(directory: PrivateGitDirectory) {
    this.privateDirectory = directory;
  }

  async disposePrivateDirectory(): Promise<void> {
    await this.privateDirectory?.dispose();
  }

  async run(args: string[], options: GitRunOptions = {}): Promise<GitOutput> {
    let isolation: NodeJS.ProcessEnv = {};
    if (options.isolated) {
      if (!this.privateDirectory)
        throw new Error("git: an isolated command needs the private git directory");
      isolation = await this.privateDirectory.environment();
    }
    const config = (options.config ?? []).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
    const result = await new Promise<GitOutput>((resolve, reject) => {
      const child = spawn(this.git, [...GIT_HARDENING_OPTIONS, ...config, ...args], {
        cwd: this.directory,
        env: this.env(options.access ?? "read", { ...isolation, ...options.env }),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: options.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
      });
      const stdout: Buffer[] = [];
      let size = 0;
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) child.kill();
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          error.code === "ENOENT"
            ? new PublishError(
                "git_missing",
                `git was not found (${this.git}). Install git ${MINIMUM_GIT_VERSION.join(".")} or newer; on a Mac run \`xcode-select --install\`.`,
              )
            : error,
        ),
      );
      child.on("close", (code, signal) =>
        resolve({
          code: code ?? (signal ? 128 : 1),
          stdout: Buffer.concat(stdout),
          stderr: redactGitText(stderr),
        }),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    });
    if (result.code !== 0 && !(options.allow ?? []).includes(result.code))
      throw new GitCommandError(args, result);
    return result;
  }

  /** stdout as trimmed text. */
  async text(args: string[], options: GitRunOptions = {}): Promise<string> {
    return (await this.run(args, options)).stdout.toString("utf8").trim();
  }

  /** The commit a revision names, or null when it names none; never fails. */
  async resolve(revision: string): Promise<string | null> {
    const result = await this.run(
      ["rev-parse", "-q", "--verify", "--end-of-options", `${revision}^{commit}`],
      { allow: [1, 128] },
    );
    const commit = result.stdout.toString("utf8").trim();
    return result.code === 0 && OBJECT_ID.test(commit) ? commit : null;
  }

  async treeOf(revision: string): Promise<string> {
    const tree = await this.text([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{tree}`,
    ]);
    if (!OBJECT_ID.test(tree)) throw new Error(`git rev-parse answered no object id for a tree`);
    return tree;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.run(
      ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant],
      { allow: [1, 128] },
    );
    return result.code === 0;
  }

  async config(key: string): Promise<string | null> {
    const result = await this.run(["config", "--local", "--get", "--end-of-options", key], {
      allow: [1],
    });
    return result.code === 0 ? result.stdout.toString("utf8").replace(/\n$/, "") : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.run(["config", "--local", "--end-of-options", key, value]);
  }

  async unsetConfig(key: string): Promise<void> {
    await this.run(["config", "--local", "--unset-all", key], { allow: [5] });
  }

  async updateRef(
    ref: string,
    value: string,
    expected?: string,
    options: Pick<GitRunOptions, "isolated"> = {},
  ): Promise<void> {
    await this.run(
      [
        "update-ref",
        "-m",
        "weldall publish",
        "--end-of-options",
        ref,
        value,
        ...(expected ? [expected] : []),
      ],
      options,
    );
  }

  async deleteRef(ref: string, options: Pick<GitRunOptions, "isolated"> = {}): Promise<void> {
    await this.run(["update-ref", "-d", "--end-of-options", ref], { ...options, allow: [1] });
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly output: GitOutput,
  ) {
    super(
      `git ${args[0] ?? ""} failed (exit ${output.code})${output.stderr.trim() ? `: ${lastLines(output.stderr)}` : ""}`,
    );
    this.name = "GitCommandError";
  }
}

const lastLines = (text: string, count = 6) =>
  text.trim().split("\n").slice(-count).join("\n").slice(0, 2_000);

/** `git version 2.39.3 (Apple Git-145)` → [2, 39, 3]. */
export function parseGitVersion(text: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function isSupportedGitVersion(version: readonly number[]): boolean {
  for (let index = 0; index < MINIMUM_GIT_VERSION.length; index += 1) {
    const have = version[index] ?? 0;
    const need = MINIMUM_GIT_VERSION[index]!;
    if (have !== need) return have > need;
  }
  return true;
}

const PULL_REQUEST_CLOSED = /weldall: the pull request of this branch is closed or merged/;

/**
 * Turns a failed fetch or push into a readable PublishError. Proxy rejections arrive as
 * `! [remote rejected] <ref> (weldall: <reason>)`; the credential helper writes its own
 * `weldall git-credential:` lines.
 */
export function describeTransferFailure(
  operation: "fetch" | "push",
  error: GitCommandError,
): PublishError {
  // `push --porcelain` reports refused refs on stdout.
  const text = `${error.output.stderr}\n${redactGitText(error.output.stdout.toString("utf8").slice(0, 64 * 1024))}`;
  const helper = /weldall git-credential: (.+)/.exec(text)?.[1]?.trim();
  if (helper) return new PublishError("git_credential", helper);
  if (PULL_REQUEST_CLOSED.test(text))
    return new PublishError(
      "pull_request_closed",
      "The pull request was merged or closed while publishing, so Weldall refused the push. Nothing was published and nothing changed in the folder. Run publish again: it starts a new pull request from the current state.",
    );
  const proxy = /\(weldall: ([^)\n]+)\)/.exec(text)?.[1] ?? /^weldall: (.+)$/m.exec(text)?.[1];
  if (proxy)
    return new PublishError(
      "push_refused",
      `Weldall refused the ${operation}: ${proxy.trim()}. Nothing was published.`,
    );
  if (/\[rejected\].*\((fetch first|non-fast-forward|stale info)\)/.test(text))
    return new PublishError(
      "branch_moved",
      "Someone changed the pull request branch while publishing. Nothing was published and nothing changed in the folder. Run publish again to include their change.",
    );
  // The git route's limits answer before git reads any ref: the status is all git shows.
  if (/returned error: 429/.test(text))
    return new PublishError(
      "rate_limit",
      `Too many git requests or transfers of yours in a short time, so the registry refused the ${operation}. Nothing was published.`,
      { hint: "Wait a minute, then run the command again." },
    );
  if (/returned error: 503/.test(text))
    return new PublishError(
      "git_route_busy",
      `The registry or your organisation's Git is busy, so the ${operation} was refused. Nothing was published.`,
      { hint: "Wait a minute, then run the command again." },
    );
  if (/couldn't find remote ref/i.test(text))
    return new PublishError(
      "branch_missing",
      "The branch to fetch does not exist in the app's repository (it may have been deleted).",
    );
  if (/HTTP 413|too large/i.test(text))
    return new PublishError(
      "too_large",
      "The publish is larger than Weldall accepts (100 MB). Remove large files from the folder, for example build output or data dumps, and add them to .gitignore.",
    );
  if (
    operation === "push" &&
    /RPC failed|unexpected disconnect|remote end hung up|send-pack: unexpected/i.test(text)
  )
    return new PublishError(
      "push_interrupted",
      "The push was cut off. With the git that ships with macOS this happens when http.postBuffer is not in effect for the Weldall git URL. Weldall sets it in this folder; check that no other configuration overrides it, then run publish again.",
    );
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(text))
    return new PublishError(
      "git_authentication",
      "git got no Weldall credential. Check that the `weldall` command is on PATH for git and that you are logged in (`weldall login`).",
    );
  if (/Could not resolve host|Failed to connect|Connection refused|timed out/i.test(text))
    return new PublishError(
      "network",
      `Could not reach Weldall for the ${operation}: ${lastLines(text, 2)}`,
    );
  return new PublishError(`${operation}_failed`, `git ${operation} failed: ${lastLines(text)}`);
}
