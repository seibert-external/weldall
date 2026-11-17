import { db } from "@weldall/db";
import { assertConnectorAccess, connectorScopeInclude } from "../connectors/access";
import { ConnectorError, type AuthorizedConnectorActor } from "../connectors/contracts";
import { isAppRepositoryReady } from "./service";

const appIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

const loadApp = (id: string) =>
  db.app.findUnique({ where: { id }, include: { connector: { include: connectorScopeInclude } } });
export type OwnApp = NonNullable<Awaited<ReturnType<typeof loadApp>>>;

/**
 * Resolves one of the caller's apps for a pull request or status call. An unknown id and another
 * person's app get the same 404, so the answer reveals nothing about other people's apps. The
 * caller must still be allowed to use the app's Git host connector, the connector must be
 * enabled and the repository must have finished creation.
 */
export async function resolveOwnApp({
  actor,
  appId,
}: {
  actor: AuthorizedConnectorActor;
  appId: string;
}): Promise<OwnApp> {
  if (actor.type === "machine")
    throw new ConnectorError(
      "connection_denied",
      "Apps are owned by people; sign in as a user.",
      403,
    );
  const app = appIdPattern.test(appId) ? await loadApp(appId) : null;
  if (!app || app.ownerId !== actor.id)
    throw new ConnectorError("not_found", "No app of yours has this id.", 404);
  assertConnectorAccess({ connector: app.connector, actor });
  if (!app.connector.enabled)
    throw new ConnectorError("disabled", "The Git host connector is disabled.", 409);
  if (!isAppRepositoryReady(app))
    throw new ConnectorError(
      "repository_not_ready",
      "The app's repository is still being created. Retry the app creation first.",
      409,
    );
  return app;
}
