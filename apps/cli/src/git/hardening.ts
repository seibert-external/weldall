/**
 * Global options that start every git command the CLI runs in a person's project folder. An
 * agent working in that folder can write `.git/config` and `.git/hooks`, while the CLI runs
 * outside the agent's sandbox, so nothing stored in the folder may make git start a program.
 * Command-line settings outrank every config file, and git hands them on to the git processes it
 * starts itself (for example the automatic maintenance after a fetch).
 *
 * Measured with Git 2.39: without these options the publish commands run the hooks
 * `post-index-change` (read-tree, add, update-index), `reference-transaction` (update-ref,
 * fetch), `pre-push` (push without `--no-verify`) and `pre-auto-gc` (maintenance after a fetch),
 * and `core.fsmonitor` (ls-files, add); with them none of these runs. Filter, diff and merge
 * drivers and credential helpers cannot be switched off here: the publish commands that could run
 * them use a private git directory (`PrivateGitDirectory`), and `assertSafeRepository` refuses a
 * folder whose config defines them.
 */
export const GIT_HARDENING_OPTIONS: readonly string[] = [
  "--no-pager",
  // No hook runs: on macOS and Linux no file can exist below /dev/null. On Windows git resolves
  // it to a directory on the current drive that does not normally exist (not measured).
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "submodule.recurse=false",
  // Only HTTPS transports: a redirection (`url.<base>.insteadOf`) cannot reach `ext::` or SSH,
  // which start programs. The git proxy is HTTPS only.
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  // A lookup of a missing object starts `git fetch <promisor remote>` in the folder's git
  // directory (the "lazy fetch"), which reads the folder's config. The child inherits these
  // options; the empty helper clears every credential helper configured before it (a transfer
  // adds the Weldall helper after it), and the empty command replaces the alternates' refs
  // command. Neither a planted helper nor such a command then runs, and no credential is handed
  // out. Cookies the server sets are not written to a file.
  "-c",
  "credential.helper=",
  "-c",
  "core.alternateRefsCommand=",
  "-c",
  "http.saveCookies=false",
];

/** Environment for every git call: newer git (2.44+) skips the lazy fetch altogether. */
export const GIT_HARDENING_ENVIRONMENT: Readonly<NodeJS.ProcessEnv> = { GIT_NO_LAZY_FETCH: "1" };
