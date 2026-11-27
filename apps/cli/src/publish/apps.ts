import {
  allowedFor,
  ambiguousRegistries,
  selectRegistry,
  type FoundRegistries,
  type OpenRegistry,
  type RegistryNeed,
} from "../git/registries.js";
import { printable } from "../git/printable.js";
import { PublishError } from "./errors.js";
import {
  openRegistryApi,
  type AdminAppList,
  type AdminListQuery,
  type AdministeredApp,
  type OwnedApp,
  type OwnedAppList,
  type RegistryApi,
  type RegistryApiOptions,
} from "./registry-api.js";
import { recordedRegistry } from "./registry-choice.js";
import { openRepository, type PublishOptions } from "./publish.js";
import { CONFIG, readState, stateIncomplete } from "./state.js";

/**
 * `weldall app list`, `confirm`, `list --all` and `set-owner`: the apps a registry keeps. Each
 * registry keeps the apps created through it and those its scan found (`GET /api/apps`,
 * `POST /api/apps/{id}/confirm`, its publish permission; `GET /api/admin/apps`,
 * `PUT /api/admin/apps/{id}/owner`, its administration permission), so the CLI asks every
 * registry the person may use and names each app's registry by its resource key. An app must be
 * confirmed as still needed every 90 days; past its review date it is only flagged, nothing is
 * stopped. Publishing does not confirm an app.
 */

/** An app with the registry that keeps it (`registry`, its resource key). */
export type AppEntry = OwnedApp & { registry: string };
export type AdministeredAppEntry = AdministeredApp & { registry: string };

/** What `weldall app list --json` prints. Names and descriptions are data people entered. */
export interface AppListReport extends Omit<OwnedAppList, "apps"> {
  outcome: "apps";
  apps: AppEntry[];
}
/** What `weldall app list --all --json` prints. */
export interface AdminAppListReport extends Omit<AdminAppList, "apps"> {
  outcome: "all_apps";
  registry: string;
  apps: AdministeredAppEntry[];
}
/** What `weldall app confirm --json` prints. */
export interface AppConfirmReport {
  outcome: "confirmed";
  app: AppEntry;
}
/** What `weldall app set-owner --json` prints. */
export interface OwnerAssignedReport {
  outcome: "owner_assigned";
  app: AdministeredAppEntry;
}

const withRegistry = <T extends object>(api: RegistryApi, app: T) => ({
  ...app,
  registry: api.registry.key,
});

/**
 * Opens the registry `key` names, or else every registry that fits `need` and grants its
 * permission to this person. Without any, the selection explains why.
 */
export async function openRegistries(
  open: OpenRegistry,
  need: RegistryNeed,
  key?: string,
  options: RegistryApiOptions = {},
): Promise<RegistryApi[]> {
  if (key !== undefined)
    return [
      await openRegistryApi(open, (found) => selectRegistry(found, { key, need }), need, options),
    ];
  let others: string[] = [];
  const first = await openRegistryApi(
    open,
    (found: FoundRegistries) => {
      const granted = found.registries.filter((registry) => allowedFor(registry, need));
      // None granted: let the selection name the reason.
      if (!granted.length) return selectRegistry(found, { need });
      others = granted.slice(1).map((registry) => registry.key);
      return granted[0]!;
    },
    need,
    options,
  );
  const rest = [];
  for (const other of others)
    rest.push(
      await openRegistryApi(
        open,
        (found) => selectRegistry(found, { key: other, need }),
        need,
        options,
      ),
    );
  return [first, ...rest];
}

export interface ListOptions extends RegistryApiOptions {
  registries: OpenRegistry;
  /** Lists only the apps of this registry (resource key). */
  registry?: string;
}

/** The person's apps from every registry they may use, the earliest review date first. */
export async function listMyApps(options: ListOptions): Promise<AppListReport> {
  const apis = await openRegistries(options.registries, "apps", options.registry, options);
  const lists = [];
  for (const api of apis) lists.push({ api, list: await api.listApps() });
  const apps = lists
    .flatMap(({ api, list }) => list.apps.map((app) => withRegistry(api, app)))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  const { reverificationDays, expiringSoonDays } = lists[0]!.list;
  return { outcome: "apps", apps, reverificationDays, expiringSoonDays };
}

/**
 * The registry that keeps `appId`: the one `key` names, the only one the person may use, or
 * the one that has the app among the person's (registries that cannot answer are skipped; when
 * no other has the app, the first failure is reported).
 */
export async function registryOfApp(
  open: OpenRegistry,
  appId: string,
  need: RegistryNeed,
  key?: string,
  options: RegistryApiOptions = {},
): Promise<RegistryApi> {
  const apis = await openRegistries(open, need, key, options);
  if (apis.length === 1) return apis[0]!;
  const keeping = [];
  // A registry that cannot answer now does not keep the others from being asked.
  const failures: unknown[] = [];
  for (const api of apis)
    try {
      await api.readApp(appId);
      keeping.push(api);
    } catch (error) {
      if (!(error instanceof PublishError && error.code === "not_found")) failures.push(error);
    }
  if (keeping.length === 1) return keeping[0]!;
  if (!keeping.length && failures.length) throw failures[0];
  const keys = apis.map(({ registry }) => registry.key).join(", ");
  throw keeping.length
    ? ambiguousRegistries(
        `Several registries have an app ${printable(appId)} of yours`,
        keeping.map(({ registry }) => registry),
      )
    : new PublishError(
        "not_found",
        `None of the registries you can use (${printable(keys)}) has an app ${printable(appId)} of yours.`,
        { hint: "`weldall app list` shows your apps and their ids." },
      );
}

export interface ConfirmOptions
  extends Pick<PublishOptions, "directory" | "git" | "environment">, RegistryApiOptions {
  /** Confirms this app instead of the one the folder records; the folder is then not read. */
  appId?: string;
  /** With `appId`: the registry's resource key; by default the CLI finds the registry. */
  registry?: string;
  registries: OpenRegistry;
}

/** Confirms the given app, or the folder's app (at the registry the folder records). */
export async function confirmMyApp(options: ConfirmOptions): Promise<AppConfirmReport> {
  let appId = options.appId;
  let api: RegistryApi;
  if (appId === undefined) {
    const folder = await openRepository(options);
    try {
      const { repository } = folder;
      appId = (await readState(repository, CONFIG.appId)) ?? undefined;
      if (!appId)
        throw new PublishError(
          "not_published",
          `${options.directory} has not been published yet, so there is no app to confirm.`,
          { hint: "Name the app: `weldall app confirm <app>`; `weldall app list` shows its id." },
        );
      const key = await readState(repository, CONFIG.registry);
      const remoteUrl = await readState(repository, CONFIG.remoteUrl);
      if (!key || !remoteUrl) throw stateIncomplete(appId);
      api = await openRegistryApi(
        options.registries,
        (found) => recordedRegistry(found, { key, remoteUrl, explicit: options.registry }),
        "changes",
        options,
      );
    } finally {
      await folder.repository.disposePrivateDirectory();
    }
  } else api = await registryOfApp(options.registries, appId, "apps", options.registry, options);
  return { outcome: "confirmed", app: withRegistry(api, await api.confirmApp(appId)) };
}

export interface AdminListOptions extends RegistryApiOptions, AdminListQuery {
  registries: OpenRegistry;
  /** The registry's resource key; needed when Weldall lists several for the administrator. */
  registry?: string;
}

/** Administrators: one page of every app of one registry, the ones to confirm first. */
export async function listAllApps(options: AdminListOptions): Promise<AdminAppListReport> {
  const { registries, registry, sleep: _sleep, ...query } = options;
  const api = await openRegistryApi(
    registries,
    (found) => selectRegistry(found, { key: registry, need: "admin" }),
    "admin",
    options,
  );
  const list = await api.listAllApps(query);
  return {
    outcome: "all_apps",
    registry: api.registry.key,
    ...list,
    apps: list.apps.map((app) => withRegistry(api, app)),
  };
}

/** A Weldall user id as the registry takes it: no spaces, control characters or `@`. */
export const isWeldallUserId = (value: string) =>
  value.length >= 1 && value.length <= 191 && /^[^\s\u0000-\u001f\u007f@]+$/.test(value);

export interface AssignOwnerOptions extends RegistryApiOptions {
  registries: OpenRegistry;
  registry?: string;
  appId: string;
  /** The new owner's Weldall user id. */
  owner: string;
}

/** Administrators: assigns or changes the owner of an app; the review date does not move. */
export async function assignOwner(options: AssignOwnerOptions): Promise<OwnerAssignedReport> {
  if (!isWeldallUserId(options.owner))
    throw new PublishError(
      "invalid_owner",
      `"${printable(options.owner, 200)}" is not a Weldall user id. An email address is not one.`,
      { hint: "The person sees their Weldall user id with `weldall whoami --json` (`subject`)." },
    );
  const api = await openRegistryApi(
    options.registries,
    (found) => selectRegistry(found, { key: options.registry, need: "admin" }),
    "admin",
    options,
  );
  return {
    outcome: "owner_assigned",
    app: withRegistry(api, await api.assignOwner(options.appId, options.owner)),
  };
}
