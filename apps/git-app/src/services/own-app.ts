import { appIdSchema, type AppHostApp } from "@weldall/sdk";
import { GitAppError } from "../errors.js";
import { lookupApp } from "../weldall.js";
import type { GitAppServices, Person } from "./context.js";

/**
 * Resolves one of the person's apps from Weldall's registry. An unknown id and another person's app get the same 404, so the
 * answer reveals nothing about other people's apps. The repository must have finished creation
 * and belong to this instance's organisation.
 */
export async function resolveOwnApp(
  services: GitAppServices,
  person: Person,
  appId: string,
  { requireReady = true }: { requireReady?: boolean } = {},
): Promise<AppHostApp> {
  const found = appIdSchema.safeParse(appId).success
    ? await lookupApp(services.weldall, { app: { id: appId }, subject: person.id })
    : null;
  if (!found || found.ownedBySubject !== true)
    throw new GitAppError("not_found", "No app of yours has this id.", 404);
  const { app } = found;
  if (app.repository.owner.toLowerCase() !== services.host.organization.toLowerCase())
    throw new GitAppError(
      "invalid_target",
      "The app's repository is not in this Git app's organisation.",
      409,
    );
  if (requireReady && !app.ready)
    throw new GitAppError(
      "repository_not_ready",
      "The app's repository is still being created. Retry the app creation first.",
      409,
    );
  return app;
}
