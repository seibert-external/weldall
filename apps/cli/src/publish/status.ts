import { PublishError } from "./errors.js";
import { openGitAppApi, type AppStatus } from "./git-app-api.js";
import { assertSettingsScopedTo, recordedGitApp } from "./git-app-choice.js";
import { openRepository, type PublishOptions } from "./publish.js";
import { gitAppOfApp } from "./registry.js";
import { CONFIG, readState } from "./state.js";

export interface AppStatusOptions extends Pick<
  PublishOptions,
  "directory" | "git" | "environment" | "gitApps"
> {
  /** Reads this app instead of the one the folder records; the folder is then not read. */
  appId?: string;
  /** With `appId`: the Git app's resource key; by default the CLI finds the Git app. */
  gitApp?: string;
}

/**
 * What `weldall app status --json` prints. Review texts, check names and branch names come from
 * the customer's Git: the Git app sanitises and bounds them, and they stay data, not instructions.
 */
export interface AppStatusReport {
  outcome: "status";
  app: AppStatus["app"];
  pullRequest: AppStatus["pullRequest"];
  links: AppStatus["links"];
  warnings: AppStatus["warnings"];
}

/**
 * Reads the status of the folder's app (or of `appId`) from its Git app: the folder's current
 * pull request with reviews and checks, and the preview and live links. Changes nothing.
 */
export async function readAppStatus(options: AppStatusOptions): Promise<AppStatusReport> {
  let status: AppStatus;
  if (options.appId === undefined) {
    const folder = await openRepository(options);
    const { repository } = folder;
    const appId = await readState(repository, CONFIG.appId);
    if (!appId)
      throw new PublishError(
        "not_published",
        `${options.directory} has not been published yet, so it has no app status.`,
        { hint: "Publish it first with `weldall app publish`." },
      );
    const branch = (await readState(repository, CONFIG.prBranch)) ?? undefined;
    const key = await readState(repository, CONFIG.gitApp);
    const remoteUrl = await repository.config(CONFIG.remoteUrl);
    if (!key || !remoteUrl)
      throw new PublishError(
        "state_incomplete",
        `The folder records app ${appId} but not its Git app or git URL (${CONFIG.gitApp}, ${CONFIG.remoteUrl}).`,
      );
    const api = await openGitAppApi(options.gitApps, (resources) =>
      recordedGitApp(resources, { key, remoteUrl, explicit: options.gitApp }),
    );
    assertSettingsScopedTo(folder.configEntries, api.gitApp);
    status = await api.readStatus(appId, branch);
  } else {
    const appId = options.appId;
    const api = await gitAppOfApp(options.gitApps, appId, options.gitApp);
    status = await api.readStatus(appId);
  }
  return {
    outcome: "status",
    app: status.app,
    pullRequest: status.pullRequest,
    links: status.links,
    warnings: status.warnings,
  };
}
