import { db } from "@weldall/db";
import { isConnectorApp, type ConnectorApp } from "../app-registry/service";
import { connectorScopeInclude } from "../connectors/access";
import type { GitRepositoryPath } from "./paths";

const loadConnector = (key: string) =>
  db.connector.findUnique({ where: { key }, include: connectorScopeInclude });

export interface ResolvedGitApp {
  app: ConnectorApp;
  connector: NonNullable<Awaited<ReturnType<typeof loadConnector>>>;
}

/**
 * Resolves a proxy path to its app registry entry. The connector key matches exactly; owner and
 * repository match case-insensitively because Git hosts treat them that way, while the registry
 * keeps the host's spelling (used for forwarding). Two entries that differ only in case are
 * ambiguous and resolve to nothing rather than to either one. The credential endpoint and the
 * proxy both resolve through here.
 */
export async function resolveGitApp(path: GitRepositoryPath): Promise<ResolvedGitApp | null> {
  const connector = await loadConnector(path.connectorKey);
  if (!connector) return null;
  // Lower-cased equality, never `ILIKE`: `_`, `%` and backslashes in a path stay literal.
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "App"
    WHERE "connectorId" = ${connector.id}
      AND lower("repositoryOwner") = lower(${path.owner})
      AND lower("repositoryName") = lower(${path.name})
    LIMIT 2`;
  const apps = ids.length === 1 ? await db.app.findMany({ where: { id: ids[0]!.id } }) : [];
  const app = apps.length === 1 ? apps[0]! : null;
  return app && isConnectorApp(app) ? { app: app as ConnectorApp, connector } : null;
}
