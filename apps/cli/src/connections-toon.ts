import { encode } from "@toon-format/toon";
import type {
  ConnectionAttempt,
  ConnectionSummary,
  ConnectorSummary,
  DisconnectResult,
} from "./services/connections.js";
import { TOON_OPTIONS, joined } from "./toon.js";

// Agents act on selectors, capabilities, and request prefixes. Owner IDs, database connector IDs,
// versions, and policy bookkeeping stay in the stable --json representation.
const connectionRow = (connection: ConnectionSummary, issuer: string) => ({
  name: connection.name,
  id: connection.id,
  connector: connection.connectorKey,
  account: connection.accountName,
  status: connection.status,
  capabilities: joined(connection.capabilities),
  requestPrefix: `${issuer}/connectors/${connection.connectorKey}/`,
  requestCount: connection.requestCount,
  lastUsedAt: connection.lastUsedAt ?? "",
});

export function connectionsToon(connections: readonly ConnectionSummary[], issuer: string): string {
  return encode(
    { connections: connections.map((connection) => connectionRow(connection, issuer)) },
    TOON_OPTIONS,
  ).concat("\n");
}

export function connectorsToon(connectors: readonly ConnectorSummary[]): string {
  return encode(
    {
      connectors: connectors.map((connector) => ({
        key: connector.key,
        name: connector.name,
        type: connector.type,
        scopes: joined(connector.scopes.map((scope) => scope.id)),
        defaultScopes: joined(connector.defaultScopes),
        requestPrefix: connector.requestPrefix,
      })),
    },
    TOON_OPTIONS,
  ).concat("\n");
}

export function connectionDetailToon(connection: ConnectionSummary, issuer: string): string {
  return encode(
    {
      ...connectionRow(connection, issuer),
      selectedScopes: connection.selectedScopes,
      grantedScopes: connection.grantedScopes,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      revocationError: connection.revocationError ?? "",
    },
    TOON_OPTIONS,
  ).concat("\n");
}

export function connectionAttemptToon(attempt: ConnectionAttempt): string {
  return encode(
    {
      id: attempt.id,
      status: attempt.status,
      connector: attempt.connector.key,
      expiresAt: attempt.expiresAt,
      selectedScopes: attempt.selectedScopes,
      capabilities: attempt.capabilities,
      connection: attempt.connection?.name ?? "",
    },
    TOON_OPTIONS,
  ).concat("\n");
}

export function disconnectToon(result: DisconnectResult): string {
  return encode(
    {
      status: result.status,
      revocationConfirmed: result.revocationConfirmed ?? false,
      message: result.message ?? "",
    },
    TOON_OPTIONS,
  ).concat("\n");
}
