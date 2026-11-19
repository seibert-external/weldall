import { PublishError } from "./errors.js";
import { openRepository, type PublishOptions } from "./publish.js";
import { CONFIG, readState } from "./state.js";
import type { AppEntry, AppList, RegistryApi } from "./weldall-api.js";

/**
 * `weldall app list` and `weldall app confirm`: the person's entries in Weldall's app registry.
 * An app must be confirmed as still needed every 90 days; past its expiry it is only flagged for
 * IT, nothing is stopped. Publishing does not confirm an app.
 */

/** What `weldall app list --json` prints. Names and purposes are data the person entered. */
export interface AppListReport extends AppList {
  outcome: "apps";
}
/** What `weldall app confirm --json` prints. */
export interface AppConfirmReport {
  outcome: "confirmed";
  app: AppEntry;
}

export async function listMyApps(api: Pick<RegistryApi, "listApps">): Promise<AppListReport> {
  return { outcome: "apps", ...(await api.listApps()) };
}

export interface ConfirmOptions extends Pick<PublishOptions, "directory" | "git" | "environment"> {
  /** Confirms this app instead of the one the folder records; the folder is then not read. */
  appId?: string;
  api: Pick<RegistryApi, "confirmApp">;
}

/** Confirms the given app, or the folder's app when no id is given. */
export async function confirmMyApp(options: ConfirmOptions): Promise<AppConfirmReport> {
  let appId = options.appId;
  if (appId === undefined) {
    const { repository } = await openRepository(options);
    appId = (await readState(repository, CONFIG.appId)) ?? undefined;
    if (!appId)
      throw new PublishError(
        "not_published",
        `${options.directory} has not been published yet, so there is no app to confirm.`,
        { hint: "Name the app: `weldall app confirm <app>`; `weldall app list` shows its id." },
      );
  }
  return { outcome: "confirmed", app: await options.api.confirmApp(appId) };
}
