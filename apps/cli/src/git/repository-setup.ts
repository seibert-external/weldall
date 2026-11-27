import { CliError } from "../errors.js";
import { printable } from "./printable.js";
import { GitCommandError, type GitRepository } from "../publish/git.js";
import { GIT_ACCESS_ENV, isGitProxyPath, type GitAccess } from "./credential-helper.js";

/**
 * The helper as git runs it: by name from PATH, so the setting survives CLI upgrades and moves of
 * the standalone binary (npm and standalone both put `weldall` on PATH). If `weldall` is missing,
 * git reports `command not found`; `gitProxyEnvironment` then still prevents a prompt.
 */
export const GIT_CREDENTIAL_HELPER = "!weldall git-credential";

/**
 * Sends pushes in one piece. Apple Git 2.39.3 with libcurl 8.7.1 aborts chunked pushes over 1 to
 * 2 MiB; 100 MB matches the proxy's transfer limit.
 */
export const GIT_POST_BUFFER_BYTES = 104_857_600;

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface GitProxyRemote {
  /** `https://<registry>/git/<owner>/<repository>.git` */
  url: string;
  /** `https://<registry>`: must be the origin of a registry Weldall lists (see `registries.ts`). */
  origin: string;
  /** `https://<registry>/git/`: every setting applies to this URL prefix only. */
  scope: string;
}

/**
 * Validates the shape of a registry's git remote URL (`<git><repository name>.git`). Only the
 * shape: whether its origin is a registry Weldall lists is for the caller to check against Weldall's
 * registry, because a stored URL comes from the folder.
 */
export function parseGitProxyRemote(remoteUrl: string): GitProxyRemote {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch (error) {
    throw new CliError(`Invalid git URL of a registry: ${printable(remoteUrl)}`, { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== remoteUrl ||
    !isGitProxyPath(url.pathname)
  )
    throw new CliError(`Not a registry's git URL: ${printable(remoteUrl)}`, {
      hint: "Expected https://<registry>/git/<owner>/<repository>.git.",
    });
  return { url: url.href, origin: url.origin, scope: `${url.origin}/git/` };
}

/**
 * The settings for the proxy, in order, as `[key, value]` pairs: usable with `git config` and,
 * for a clone, with `git clone -c key=value` (applies before the first fetch). The empty helper
 * value clears every helper configured before it (system, global, or the keychain), so a
 * credential reaches no other helper and is stored nowhere.
 */
export function gitProxySettings(remoteUrl: string): Array<[string, string]> {
  const { scope } = parseGitProxyRemote(remoteUrl);
  return [
    [`credential.${scope}.helper`, ""],
    [`credential.${scope}.helper`, GIT_CREDENTIAL_HELPER],
    [`credential.${scope}.useHttpPath`, "true"],
    [`http.${scope}.postBuffer`, String(GIT_POST_BUFFER_BYTES)],
  ];
}

/**
 * Environment for running git non-interactively against the proxy (the publish step runs git
 * through it). A failing helper answers `quit=1`; these cover the rest: no terminal prompt, and an
 * empty `GIT_ASKPASS`, which stops both `GIT_ASKPASS` and `SSH_ASKPASS` (IDE terminals set
 * them, and `core.askpass` does not override the variable). `access` selects the credential.
 */
export function gitProxyEnvironment({
  access = "read",
  base = process.env,
}: { access?: GitAccess; base?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    [GIT_ACCESS_ENV]: access,
  };
}

export interface ConfigureRepositoryOptions {
  /** The local repository; its git calls carry the hardening options (`GitRepository.run`). */
  repository: GitRepository;
  remoteUrl: string;
  remoteName?: string;
}

/**
 * Points a local repository at a registry's git route, idempotently: the remote (`weldall` by default, so
 * an existing `origin` stays), then the proxy settings in the repository's own config, all
 * scoped to `https://<registry>/git/` so no other remote changes.
 */
export async function configureGitProxyRepository({
  repository,
  remoteUrl,
  remoteName = "weldall",
}: ConfigureRepositoryOptions): Promise<void> {
  const remote = parseGitProxyRemote(remoteUrl);
  if (!REMOTE_NAME.test(remoteName)) throw new CliError(`Invalid git remote name: ${remoteName}`);
  const config = async (args: string[], { missingOk = false } = {}) => {
    try {
      // `git config --unset-all` exits 5 when the key does not exist.
      await repository.run(["config", "--local", ...args], { allow: missingOk ? [5] : [] });
    } catch (error) {
      const stderr = error instanceof GitCommandError ? error.output.stderr.trim() : "";
      throw new CliError(`Configuring the git repository in ${repository.directory} failed`, {
        cause: error,
        ...(stderr ? { hint: stderr } : {}),
      });
    }
  };

  await config(["--replace-all", `remote.${remoteName}.url`, remote.url]);
  // A push URL would send pushes past the proxy.
  await config(["--unset-all", `remote.${remoteName}.pushurl`], { missingOk: true });
  await config([
    "--replace-all",
    `remote.${remoteName}.fetch`,
    `+refs/heads/*:refs/remotes/${remoteName}/*`,
  ]);
  const settings = gitProxySettings(remote.url);
  for (const key of new Set(settings.map(([key]) => key)))
    await config(["--unset-all", key], { missingOk: true });
  for (const [key, value] of settings) await config(["--add", key, value]);
}
