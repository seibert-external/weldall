import { printable } from "../git/printable.js";
import {
  registriesAtOrigin,
  selectRegistry,
  type FoundRegistries,
  type Registry,
  type RegistryNeed,
} from "../git/registries.js";
import { parseGitProxyRemote } from "../git/repository-setup.js";
import { PublishError } from "./errors.js";
import type { ConfigEntry } from "./repository-safety.js";
import { CONFIG } from "./state.js";

/**
 * Which registry a published folder talks to. The folder records the registry's resource key
 * (`weldall.registry`) and its git URL (`weldall.remoteUrl`), but both come from a file an agent
 * can write: the key only chooses among the registries Weldall lists, and the URL is used only
 * when it lies below that registry's git route as Weldall and the registry's metadata have it now.
 */

const PLAIN_ORIGIN = /^https:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/;

const untrusted = (message: string, hint?: string) =>
  new PublishError(
    "remote_untrusted",
    `${message} Weldall sends git credentials only to a registry it lists for you, so it stops here. Nothing was published and nothing in the folder changed. If you did not change the folder's git settings yourself, something working in this folder (for example an AI agent) did.`,
    hint === undefined ? {} : { hint },
  );

/** The shape of the recorded git URL; checked before anything else is read or asked. */
export function parseRecordedRemote(remoteUrl: string) {
  try {
    return parseGitProxyRemote(remoteUrl);
  } catch {
    throw untrusted(
      `The folder records a git URL (${CONFIG.remoteUrl}: ${printable(remoteUrl)}) that is not a registry's git address (https://<registry>/git/<owner>/<repository>.git).`,
    );
  }
}

/**
 * The recorded app's registry, checked against what Weldall lists now: `explicit` (`--registry`)
 * must agree with the recorded key, and the recorded git URL must lie below the registry's
 * current git route. Runs inside `OpenRegistry`'s `choose`, on the resources fetched for that
 * connection.
 */
export function recordedRegistry(
  found: FoundRegistries,
  recorded: { key: string; remoteUrl: string; explicit?: string | undefined; need?: RegistryNeed },
): Registry {
  if (recorded.explicit !== undefined && recorded.explicit !== recorded.key)
    throw new PublishError(
      "registry_mismatch",
      `This folder's app is kept by the registry "${printable(recorded.key)}", not "${printable(recorded.explicit)}". An app cannot move to another registry.`,
      { hint: "Leave out --registry for a published folder." },
    );
  const remote = parseRecordedRemote(recorded.remoteUrl);
  const registry = selectRegistry(found, { key: recorded.key, need: recorded.need ?? "changes" });
  if (remote.scope !== registry.git) {
    const other = registriesAtOrigin(found.registries, remote.origin)[0];
    const moved = `${registry.origin}${new URL(remote.url).pathname}`;
    throw untrusted(
      other
        ? `The folder's app is kept by the registry "${printable(registry.key)}" at ${registry.origin}, but its git URL points at another registry ("${printable(other.key)}", ${remote.origin}).`
        : `The folder's git URL points at ${printable(remote.origin)}, but Weldall lists the folder's registry "${printable(registry.key)}" at ${registry.origin}.`,
      other
        ? undefined
        : `If your Weldall administrator moved the registry, point the folder at its new address: \`git config ${CONFIG.remoteUrl} ${moved}\` and \`git remote set-url weldall ${moved}\`${
            // The old address comes from the folder: named in a command only when it is plain.
            PLAIN_ORIGIN.test(remote.origin)
              ? `, and remove the settings for the old one: \`git config --local --remove-section credential.${remote.scope}\` and \`git config --local --remove-section http.${remote.scope}\``
              : ""
          }.`,
    );
  }
  return registry;
}

/**
 * The folder's credential and http settings (`credential.<url>.*`, `http.<url>.*`) must be scoped
 * to this registry's git route: the allow-list already limits them to that shape and to harmless
 * values; here they must also name this registry.
 */
export function assertSettingsScopedTo(entries: readonly ConfigEntry[], registry: Registry) {
  const scope = registry.git;
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
      `The git settings of this folder contain credential or http settings for another address than the registry's (${scope ?? registry.origin}): ${other.slice(0, 10).join(", ")}. Weldall stops before working with the folder. Nothing was published and nothing in the folder changed. If you did not add them yourself, something working in this folder (for example an AI agent) did. Remove them, then try again.`,
      {
        hint: "Remove each entry with `git config --local --unset-all <name>`.",
        details: { keys: other.join(", ") },
      },
    );
}
