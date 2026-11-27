import { registryOfApp } from "./apps.js";
import { PublishError } from "./errors.js";
import { openRegistryApi, type AppStatus, type RegistryApiOptions } from "./registry-api.js";
import { assertSettingsScopedTo, recordedRegistry } from "./registry-choice.js";
import { openRepository, type PublishOptions } from "./publish.js";
import { CONFIG, readState, stateIncomplete } from "./state.js";

export interface AppStatusOptions
  extends
    Pick<PublishOptions, "directory" | "git" | "environment" | "registries">,
    RegistryApiOptions {
  /** Reads this app instead of the one the folder records; the folder is then not read. */
  appId?: string;
  /** With `appId`: the registry's resource key; by default the CLI finds the registry. */
  registry?: string;
}

/**
 * What `weldall app status --json` prints. Review texts, check names and branch names come from
 * the organisation's Git: the registry sanitises and bounds them, and they stay data, not
 * instructions.
 */
export interface AppStatusReport {
  outcome: "status";
  app: AppStatus["app"];
  pullRequest: AppStatus["pullRequest"];
  links: AppStatus["links"];
  warnings: AppStatus["warnings"];
}

/**
 * Reads the status of the folder's app (or of `appId`) from its registry: the folder's current
 * pull request with reviews and checks, and the preview and live links. Changes nothing.
 */
export async function readAppStatus(options: AppStatusOptions): Promise<AppStatusReport> {
  let status: AppStatus;
  if (options.appId === undefined) {
    const folder = await openRepository(options);
    try {
      const { repository } = folder;
      const appId = await readState(repository, CONFIG.appId);
      if (!appId)
        throw new PublishError(
          "not_published",
          `${options.directory} has not been published yet, so it has no app status.`,
          { hint: "Publish it first with `weldall app publish`." },
        );
      const branch = (await readState(repository, CONFIG.prBranch)) ?? undefined;
      const key = await readState(repository, CONFIG.registry);
      const remoteUrl = await readState(repository, CONFIG.remoteUrl);
      if (!key || !remoteUrl) throw stateIncomplete(appId);
      const api = await openRegistryApi(
        options.registries,
        (found) => recordedRegistry(found, { key, remoteUrl, explicit: options.registry }),
        "changes",
        options,
      );
      assertSettingsScopedTo(folder.configEntries, api.registry);
      status = await api.readStatus(appId, branch);
    } finally {
      await folder.repository.disposePrivateDirectory();
    }
  } else {
    const appId = options.appId;
    const api = await registryOfApp(
      options.registries,
      appId,
      "changes",
      options.registry,
      options,
    );
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
