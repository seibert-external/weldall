import type { ResourceRegistryEntry } from "@weldall/sdk";
import {
  GIT_APP_SCOPES,
  ambiguousGitApps,
  asGitApp,
  selectGitApp,
  type OpenGitApp,
} from "../git/git-apps.js";
import { PublishError } from "./errors.js";
import {
  openGitAppApi,
  type GitAppApi,
  type GitAppAppEntry,
  type GitAppAppList,
} from "./git-app-api.js";
import { recordedGitApp } from "./git-app-choice.js";
import { openRepository, type PublishOptions } from "./publish.js";
import { CONFIG, readState } from "./state.js";

/**
 * `weldall app list` and `weldall app confirm`: the person's entries in the app registry. Each Git
 * app keeps the registry of the apps it holds (`GET /api/apps`, `POST /api/apps/{id}/confirm`,
 * scope `git-app:publish`), so the CLI asks every Git app the person may publish with and names
 * each app's Git app by its resource key. An app must be confirmed as still needed every 90 days;
 * past its expiry it is only flagged for IT, nothing is stopped. Publishing does not confirm an app.
 */

/** An app registry entry with the Git app that keeps it (`repository.resource`, its resource key). */
export interface AppEntry extends Omit<GitAppAppEntry, "repository"> {
  repository: GitAppAppEntry["repository"] & { resource: string };
}

/** What `weldall app list --json` prints. Names and purposes are data the person entered. */
export interface AppListReport extends Omit<GitAppAppList, "apps"> {
  outcome: "apps";
  apps: AppEntry[];
}
/** What `weldall app confirm --json` prints. */
export interface AppConfirmReport {
  outcome: "confirmed";
  app: AppEntry;
}

const withResource = (gitApp: GitAppApi["gitApp"], app: GitAppAppEntry): AppEntry => ({
  ...app,
  repository: { resource: gitApp.key, ...app.repository },
});

/**
 * Opens the Git app `key` names, or else every Git app that offers and grants `git-app:publish`
 * to this person. Without any, the selection explains why (`no_git_app`, `scope_missing`).
 */
export async function openPublishGitApps(open: OpenGitApp, key?: string): Promise<GitAppApi[]> {
  const scope = GIT_APP_SCOPES.publish;
  if (key !== undefined) return [await openGitAppApi(open, (r) => selectGitApp(r, { key, scope }))];
  let others: string[] = [];
  const first = await openGitAppApi(open, (resources: ResourceRegistryEntry[]) => {
    const granted = resources
      .map((resource) => asGitApp(resource, scope))
      .filter((app) => app !== null && app.resource.grantedScopes.includes(scope));
    // None granted: let the selection name the reason.
    if (!granted.length) return selectGitApp(resources, { scope });
    others = granted.slice(1).map((app) => app!.key);
    return granted[0]!;
  });
  const rest = [];
  for (const other of others)
    rest.push(await openGitAppApi(open, (r) => selectGitApp(r, { key: other, scope })));
  return [first, ...rest];
}

export interface ListOptions {
  gitApps: OpenGitApp;
  /** Lists only the apps of this Git app (resource key). */
  gitApp?: string;
}

/** The person's apps from every Git app they may publish with, the earliest expiry first. */
export async function listMyApps(options: ListOptions): Promise<AppListReport> {
  const apis = await openPublishGitApps(options.gitApps, options.gitApp);
  const lists = [];
  for (const api of apis) lists.push({ api, list: await api.listApps() });
  const apps = lists
    .flatMap(({ api, list }) => list.apps.map((app) => withResource(api.gitApp, app)))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  const { reverificationDays, expiringSoonDays } = lists[0]!.list;
  return { outcome: "apps", apps, reverificationDays, expiringSoonDays };
}

/**
 * The Git app that keeps `appId`: the one `key` names, the only one the person may publish
 * with, or the one whose registry lists the app among the person's (Git apps that cannot answer
 * are skipped; when no other lists the app, the first failure is reported).
 */
export async function gitAppOfApp(
  open: OpenGitApp,
  appId: string,
  key?: string,
): Promise<GitAppApi> {
  const apis = await openPublishGitApps(open, key);
  if (apis.length === 1) return apis[0]!;
  const keeping = [];
  // A Git app that cannot answer now does not keep the others from being asked.
  const failures: unknown[] = [];
  for (const api of apis)
    try {
      if ((await api.listApps()).apps.some(({ id }) => id === appId)) keeping.push(api);
    } catch (error) {
      failures.push(error);
    }
  if (keeping.length === 1) return keeping[0]!;
  if (!keeping.length && failures.length) throw failures[0];
  const keys = apis.map(({ gitApp }) => gitApp.key).join(", ");
  throw keeping.length
    ? ambiguousGitApps(
        `Several Git apps list an app ${appId} of yours`,
        keeping.map(({ gitApp }) => gitApp),
      )
    : new PublishError(
        "not_found",
        `None of the Git apps you can publish with (${keys}) has an app ${appId} of yours.`,
        { hint: "`weldall app list` shows your apps and their ids." },
      );
}

export interface ConfirmOptions extends Pick<PublishOptions, "directory" | "git" | "environment"> {
  /** Confirms this app instead of the one the folder records; the folder is then not read. */
  appId?: string;
  /** With `appId`: the Git app's resource key; by default the CLI finds the Git app. */
  gitApp?: string;
  gitApps: OpenGitApp;
}

/** Confirms the given app, or the folder's app (at the Git app the folder records). */
export async function confirmMyApp(options: ConfirmOptions): Promise<AppConfirmReport> {
  let appId = options.appId;
  let api: GitAppApi;
  if (appId === undefined) {
    const { repository } = await openRepository(options);
    appId = (await readState(repository, CONFIG.appId)) ?? undefined;
    if (!appId)
      throw new PublishError(
        "not_published",
        `${options.directory} has not been published yet, so there is no app to confirm.`,
        { hint: "Name the app: `weldall app confirm <app>`; `weldall app list` shows its id." },
      );
    const key = await readState(repository, CONFIG.gitApp);
    const remoteUrl = await repository.config(CONFIG.remoteUrl);
    if (!key || !remoteUrl)
      throw new PublishError(
        "state_incomplete",
        `The folder records app ${appId} but not its Git app or git URL (${CONFIG.gitApp}, ${CONFIG.remoteUrl}).`,
      );
    api = await openGitAppApi(options.gitApps, (resources) =>
      recordedGitApp(resources, { key, remoteUrl, explicit: options.gitApp }),
    );
  } else api = await gitAppOfApp(options.gitApps, appId, options.gitApp);
  return { outcome: "confirmed", app: withResource(api.gitApp, await api.confirmApp(appId)) };
}
