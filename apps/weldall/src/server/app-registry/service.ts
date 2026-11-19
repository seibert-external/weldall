import { db, type App, type Prisma } from "@weldall/db";
import { APP_REVERIFICATION_DAYS, reverificationExpiry } from "./state";

export { APP_REVERIFICATION_DAYS };

type Client = Prisma.TransactionClient;

export interface NewApp {
  name: string;
  purpose: string;
  ownerId: string;
  /** The repository behind the Git app (a registered resource) that keeps it. */
  repository: {
    resourceId: string;
    owner: string;
    name: string;
    id?: string | null;
    /** Browser link reported by the Git app. */
    webUrl?: string | null;
  };
  /** Branch the Git app refuses pushes to. */
  defaultBranch: string;
  /** `commit` stays null until creation finished; see {@link isAppRepositoryReady}. */
  template?: { name: string; commit: string | null } | null;
  /** Defaults to {@link APP_REVERIFICATION_DAYS} after creation. */
  expiresAt?: Date;
}

/**
 * Registers a published app. A second entry for the same repository of the same resource fails on
 * the unique key.
 */
export function createApp(input: NewApp, client: Client = db): Promise<App> {
  return client.app.create({
    data: {
      name: input.name,
      purpose: input.purpose,
      ownerId: input.ownerId,
      resourceId: input.repository.resourceId,
      repositoryOwner: input.repository.owner,
      repositoryName: input.repository.name,
      repositoryId: input.repository.id ?? null,
      repositoryWebUrl: input.repository.webUrl ?? null,
      defaultBranch: input.defaultBranch,
      template: input.template?.name ?? null,
      templateCommit: input.template?.commit ?? null,
      expiresAt: input.expiresAt ?? reverificationExpiry(),
    },
  });
}

/**
 * Whether the app's repository finished creation. The Git app registers a template app with a
 * null template commit before it waits for and checks the new repository, so that a retry resumes
 * with the same repository; it reports the commit (the head of the new default branch) once every
 * check passed. Apps registered from an existing repository (no template) are ready when
 * registered.
 */
export function isAppRepositoryReady(app: Pick<App, "template" | "templateCommit">): boolean {
  return app.template === null || app.templateCommit !== null;
}
