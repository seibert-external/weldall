import type { ResourceRegistryEntry } from "@weldall/sdk";
import { GIT_APP_SCOPES, gitAppsAtOrigin, selectGitApp, type GitApp } from "../git/git-apps.js";
import { parseGitProxyRemote } from "../git/repository-setup.js";
import { PublishError } from "./errors.js";
import type { ConfigEntry } from "./repository-safety.js";
import { CONFIG } from "./state.js";

/**
 * Which Git app a published folder talks to. The folder records the Git app's resource key
 * (`weldall.gitApp`) and its git URL (`weldall.remoteUrl`), but both come from a file an agent can
 * write: the key only chooses among the Git apps Weldall lists, and the URL is used only when it
 * lies below that Git app's `/git/` as the registry has it now.
 */

const PLAIN_ORIGIN = /^https:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/;
const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);

const untrusted = (message: string, hint?: string) =>
  new PublishError(
    "remote_untrusted",
    `${message} Weldall sends git credentials only to a Git app it lists for you, so it stops here. Nothing was published and nothing in the folder changed. If you did not change the folder's git settings yourself, something working in this folder (for example an AI agent) did.`,
    hint === undefined ? {} : { hint },
  );

/** The shape of the recorded git URL; checked before anything else is read or asked. */
export function parseRecordedRemote(remoteUrl: string) {
  try {
    return parseGitProxyRemote(remoteUrl);
  } catch {
    throw untrusted(
      `The folder records a git URL (${CONFIG.remoteUrl}: ${printable(remoteUrl)}) that is not a Git app's git address (https://<git app>/git/<owner>/<repository>.git).`,
    );
  }
}

/**
 * The recorded app's Git app, checked against the registry: `explicit` (`--git-app`) must agree
 * with the recorded key, and the recorded git URL must lie below the Git app's current origin.
 * Runs inside `OpenGitApp`'s `choose`, on the registry fetched for that connection.
 */
export function recordedGitApp(
  resources: readonly ResourceRegistryEntry[],
  recorded: { key: string; remoteUrl: string; explicit?: string | undefined },
): GitApp {
  if (recorded.explicit !== undefined && recorded.explicit !== recorded.key)
    throw new PublishError(
      "git_app_mismatch",
      `This folder's app is kept by the Git app "${printable(recorded.key)}", not "${printable(recorded.explicit)}". An app cannot move to another Git app.`,
      { hint: "Leave out --git-app for a published folder." },
    );
  const remote = parseRecordedRemote(recorded.remoteUrl);
  const gitApp = selectGitApp(resources, { key: recorded.key, scope: GIT_APP_SCOPES.publish });
  if (remote.origin !== gitApp.origin) {
    const other = gitAppsAtOrigin(resources, remote.origin)[0];
    const moved = `${gitApp.origin}${new URL(remote.url).pathname}`;
    throw untrusted(
      other
        ? `The folder's app is kept by the Git app "${printable(gitApp.key)}" at ${gitApp.origin}, but its git URL points at another Git app ("${printable(other.key)}", ${remote.origin}).`
        : `The folder's git URL points at ${printable(remote.origin)}, but Weldall lists the folder's Git app "${printable(gitApp.key)}" at ${gitApp.origin}.`,
      other
        ? undefined
        : `If your Weldall administrator moved the Git app, point the folder at its new address: \`git config ${CONFIG.remoteUrl} ${moved}\` and \`git remote set-url weldall ${moved}\`${
            // The old address comes from the folder: named in a command only when it is plain.
            PLAIN_ORIGIN.test(remote.origin)
              ? `, and remove the settings for the old one: \`git config --local --remove-section credential.${remote.scope}\` and \`git config --local --remove-section http.${remote.scope}\``
              : ""
          }.`,
    );
  }
  return gitApp;
}

/**
 * The folder's credential and http settings (`credential.<url>.*`, `http.<url>.*`) must be scoped
 * to this Git app's `/git/`: the allow-list already limits them to that shape and to harmless
 * values; here they must also name this Git app.
 */
export function assertSettingsScopedTo(entries: readonly ConfigEntry[], gitApp: GitApp) {
  const scope = `${gitApp.origin}/git/`;
  const other = [
    ...new Set(
      entries
        .filter(
          ({ section, subsection }) =>
            (section === "credential" || section === "http") && subsection !== scope,
        )
        .map(({ key }) => printable(key)),
    ),
  ];
  if (other.length)
    throw new PublishError(
      "unsafe_git_config",
      `The git settings of this folder contain credential or http settings for another address than the Git app's (${scope}): ${other.slice(0, 10).join(", ")}. Weldall stops before working with the folder. Nothing was published and nothing in the folder changed. If you did not add them yourself, something working in this folder (for example an AI agent) did. Remove them, then try again.`,
      {
        hint: "Remove each entry with `git config --local --unset-all <name>`.",
        details: { keys: other.join(", ") },
      },
    );
}
