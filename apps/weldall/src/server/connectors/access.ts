import { ConnectorError, type AuthorizedConnectorActor } from "./contracts";

export const connectorScopeInclude = {
  requiredScopes: { include: { scope: { select: { key: true } } } },
} as const;

type ConnectorAccessPolicy = {
  requiredScopes: { scope: { key: string } }[];
};

/** Returns required application scope keys in stable order for public configuration state. */
export function connectorRequiredScopeKeys(connector: ConnectorAccessPolicy): string[] {
  return connector.requiredScopes.map(({ scope }) => scope.key).sort();
}

/** Reports whether an authenticated actor holds every scope required by a connector. */
export function canAccessConnector({
  connector,
  actor,
}: {
  connector: ConnectorAccessPolicy;
  actor: Pick<AuthorizedConnectorActor, "scopeKeys">;
}): boolean {
  const granted = new Set<string>(actor.scopeKeys);
  return connector.requiredScopes.every(({ scope }) => granted.has(scope.key));
}

/** Rejects connector setup or execution unless the actor holds every required scope. */
export function assertConnectorAccess({
  connector,
  actor,
}: {
  connector: ConnectorAccessPolicy;
  actor: Pick<AuthorizedConnectorActor, "scopeKeys">;
}): void {
  if (!canAccessConnector({ connector, actor }))
    throw new ConnectorError(
      "connection_denied",
      "Connector is not available to this caller.",
      403,
    );
}
