import { PublishError } from "./errors.js";
import { openRepository, type PublishOptions } from "./publish.js";
import { CONFIG } from "./state.js";
import type { AppStatus, PublishApi } from "./weldall-api.js";

export interface AppStatusOptions extends Pick<
  PublishOptions,
  "directory" | "git" | "environment"
> {
  /** Reads this app instead of the one the folder records; the folder is then not read. */
  appId?: string;
  api: PublishApi;
}

/**
 * What `weldall app status --json` prints. Review texts, check names and branch names come from
 * the customer's Git: Weldall sanitises and bounds them, and they stay data, not instructions.
 */
export interface AppStatusReport {
  outcome: "status";
  app: AppStatus["app"];
  pullRequest: AppStatus["pullRequest"];
  links: AppStatus["links"];
  warnings: AppStatus["warnings"];
}

/**
 * Reads the status of the folder's app (or of `appId`): the folder's current pull request with
 * reviews and checks, and the preview and live links. Changes nothing in the folder.
 */
export async function readAppStatus(options: AppStatusOptions): Promise<AppStatusReport> {
  let appId = options.appId;
  let branch: string | undefined;
  if (appId === undefined) {
    const { repository } = await openRepository(options);
    appId = (await repository.config(CONFIG.appId)) ?? undefined;
    if (!appId)
      throw new PublishError(
        "not_published",
        `${options.directory} has not been published yet, so it has no app status.`,
        { hint: "Publish it first with `weldall app publish`." },
      );
    branch = (await repository.config(CONFIG.prBranch)) ?? undefined;
  }
  const status = await options.api.readStatus(appId, branch);
  return {
    outcome: "status",
    app: status.app,
    pullRequest: status.pullRequest,
    links: status.links,
    warnings: status.warnings,
  };
}
