import { encode } from "@toon-format/toon";
import type {
  ConnectionAttempt,
  ConnectionSummary,
  ConnectorSummary,
  DisconnectResult,
} from "./services/connections.js";
import { TOON_OPTIONS, joined } from "./toon.js";

/**
 * Projects one connection to the selectors and exact scopes agents can act on. Owner IDs, database
 * connector IDs, versions, and policy bookkeeping remain in the stable JSON representation.
 */
const buildConnectionRow = ({
  connection,
  issuer,
}: {
  connection: ConnectionSummary;
  issuer: string;
}) => ({
  name: connection.name,
  id: connection.id,
  connector: connection.connectorKey,
  account: connection.accountName,
  status: connection.status,
  scopes: joined(connection.grantedScopes),
  issuer,
  requestCount: connection.requestCount,
  lastUsedAt: connection.lastUsedAt ?? "",
});

/** Encodes connection selectors and scopes for compact agent-oriented CLI output. */
export function encodeConnectionsToon({
  connections,
  issuer,
}: {
  connections: readonly ConnectionSummary[];
  issuer: string;
}): string {
  return encode(
    { connections: connections.map((connection) => buildConnectionRow({ connection, issuer })) },
    TOON_OPTIONS,
  ).concat("\n");
}

/** Encodes connector discovery metadata for compact agent-oriented CLI output. */
export function encodeConnectorsToon(connectors: readonly ConnectorSummary[]): string {
  return encode(
    {
      connectors: connectors.map((connector) => ({
        key: connector.key,
        name: connector.name,
        type: connector.type,
        scopes: joined(connector.scopes.map((scope) => scope.id)),
        defaultScopes: joined(connector.defaultScopes),
      })),
    },
    TOON_OPTIONS,
  ).concat("\n");
}

/** Encodes one connection's actionable state while leaving database plumbing in JSON output. */
export function encodeConnectionDetailToon({
  connection,
  issuer,
}: {
  connection: ConnectionSummary;
  issuer: string;
}): string {
  return encode(
    {
      ...buildConnectionRow({ connection, issuer }),
      selectedScopes: connection.selectedScopes,
      grantedScopes: connection.grantedScopes,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      revocationError: connection.revocationError ?? "",
    },
    TOON_OPTIONS,
  ).concat("\n");
}

/** Encodes one authorization attempt for agent-visible setup recovery. */
export function encodeConnectionAttemptToon(attempt: ConnectionAttempt): string {
  return encode(
    {
      id: attempt.id,
      status: attempt.status,
      connector: attempt.connector.key,
      expiresAt: attempt.expiresAt,
      selectedScopes: attempt.selection.scopes,
      connection: attempt.connection?.name ?? "",
    },
    TOON_OPTIONS,
  ).concat("\n");
}

/** Encodes the revocation outcome returned by an explicit disconnect command. */
export function encodeDisconnectToon(result: DisconnectResult): string {
  return encode(
    {
      status: result.status,
      revocationConfirmed: result.revocationConfirmed ?? false,
      message: result.message ?? "",
    },
    TOON_OPTIONS,
  ).concat("\n");
}
