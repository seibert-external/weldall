import { db, type App, type Prisma } from "@weldall/db";

type Client = Prisma.TransactionClient;

/** Owners re-confirm a registered app after this many days (INV-183). */
export const APP_REVERIFICATION_DAYS = 90;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** The repository an app lives in, identified on its Git host connector. */
export interface AppRepository {
  connectorId: string;
  owner: string;
  name: string;
}

/** The repository an app lives in, identified behind a Git app registered as a resource. */
export interface ResourceAppRepository {
  resourceId: string;
  owner: string;
  name: string;
}

/** A registry entry whose repository lives on a Git host connector inside Weldall. */
export type ConnectorApp = App & { connectorId: string; resourceId: null };

/**
 * Narrows an entry to the in-server Git host path. The git proxy, git credentials, pull requests
 * and status only serve these; an app of a Git app (resource) is served by that Git app.
 */
export function isConnectorApp<T extends Pick<App, "connectorId">>(
  app: T,
): app is T & { connectorId: string } {
  return app.connectorId !== null;
}

export interface NewApp {
  name: string;
  purpose: string;
  ownerId: string;
  repository: (AppRepository | ResourceAppRepository) & {
    id?: string | null;
    /** Browser link reported by a Git app; ignored for connector apps. */
    webUrl?: string | null;
  };
  /** Branch the git proxy refuses pushes to. */
  defaultBranch: string;
  /** `commit` stays null until creation finished; see {@link isAppRepositoryReady}. */
  template?: { name: string; commit: string | null } | null;
  /** Defaults to {@link APP_REVERIFICATION_DAYS} after creation. */
  expiresAt?: Date;
}

/**
 * Registers a published app. Pass the transaction that creates the repository so that a failed
 * registration rolls back with it; a second entry for the same repository fails on the unique key.
 */
export function createApp(input: NewApp, client: Client = db): Promise<App> {
  const host =
    "connectorId" in input.repository
      ? { connectorId: input.repository.connectorId, repositoryWebUrl: null }
      : {
          resourceId: input.repository.resourceId,
          repositoryWebUrl: input.repository.webUrl ?? null,
        };
  return client.app.create({
    data: {
      name: input.name,
      purpose: input.purpose,
      ownerId: input.ownerId,
      ...host,
      repositoryOwner: input.repository.owner,
      repositoryName: input.repository.name,
      repositoryId: input.repository.id ?? null,
      defaultBranch: input.defaultBranch,
      template: input.template?.name ?? null,
      templateCommit: input.template?.commit ?? null,
      expiresAt: input.expiresAt ?? new Date(Date.now() + APP_REVERIFICATION_DAYS * DAY_IN_MS),
    },
  });
}

/** Resolves the registry entry for one repository on a connector, or null when it is not registered. */
export function findAppByRepository(
  repository: AppRepository,
  client: Client = db,
): Promise<App | null> {
  return client.app.findUnique({
    where: {
      connectorId_repositoryOwner_repositoryName: {
        connectorId: repository.connectorId,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
      },
    },
  });
}

/**
 * Whether the app's repository finished creation: the host confirmed it private, its default
 * branch exists and the prerequisites (reviewer team access) passed. Creation registers a template
 * app with a null template commit before waiting and checking, so that a retry resumes with the
 * same repository; only {@link markAppRepositoryReady} sets the commit. The git proxy and every
 * later publish step must refuse apps that are not ready. Apps registered from an existing
 * repository (no template) are ready when registered.
 */
export function isAppRepositoryReady(app: Pick<App, "template" | "templateCommit">): boolean {
  return app.template === null || app.templateCommit !== null;
}

/**
 * Marks a template app's repository as created by recording the template commit (the head of the
 * new default branch). Call only after every creation check passed; the commit is set once.
 */
export async function markAppRepositoryReady(
  id: string,
  templateCommit: string,
  client: Client = db,
): Promise<App> {
  await client.app.updateMany({ where: { id, templateCommit: null }, data: { templateCommit } });
  return client.app.findUniqueOrThrow({ where: { id } });
}

/** Lists the apps one user owns, newest first. */
export function listAppsByOwner(ownerId: string, client: Client = db): Promise<App[]> {
  return client.app.findMany({
    where: { ownerId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

/** Records the preview or live link the host's CI reported; omitted links stay, null clears one. */
export function updateAppLinks(
  id: string,
  links: { previewUrl?: string | null; liveUrl?: string | null },
  client: Client = db,
): Promise<App> {
  const { previewUrl, liveUrl } = links;
  return client.app.update({
    where: { id },
    data: {
      ...(previewUrl === undefined ? {} : { previewUrl }),
      ...(liveUrl === undefined ? {} : { liveUrl }),
    },
  });
}
