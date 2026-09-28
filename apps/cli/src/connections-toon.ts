import { encode } from "@toon-format/toon";
import type {
  ConnectionAttempt,
  ConnectionSummary,
  ConnectorSummary,
  DisconnectResult,
} from "./services/connections.js";
import { TOON_OPTIONS, joined } from "./toon.js";
import {
  AGENTIC_CONNECTION_USAGE_DISCOVERY_HINT,
  connectionShowCommand,
  connectionUsage,
} from "./connection-usage.js";

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
  showCommand: `${connectionShowCommand(connection.name)} --agentic`,
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
    {
      usageHints: AGENTIC_CONNECTION_USAGE_DISCOVERY_HINT,
      connections: connections.map((connection) => buildConnectionRow({ connection, issuer })),
    },
    TOON_OPTIONS,
  ).concat("\n");
}

const activeConnections = (connections: readonly ConnectionSummary[]) =>
  connections.filter((connection) => connection.status !== "DISCONNECTED");

/** Encodes connector discovery metadata and current connection state for agent-oriented output. */
export function encodeConnectorsToon({
  connectors,
  connections,
}: {
  connectors: readonly ConnectorSummary[];
  connections: readonly ConnectionSummary[];
}): string {
  const active = activeConnections(connections);
  const connectionsByConnector = new Map<string, ConnectionSummary[]>();
  for (const connection of active) {
    const matches = connectionsByConnector.get(connection.connectorKey) ?? [];
    matches.push(connection);
    connectionsByConnector.set(connection.connectorKey, matches);
  }
  return encode(
    {
      usageHints: AGENTIC_CONNECTION_USAGE_DISCOVERY_HINT,
      connectors: connectors.map((connector) => {
        const matches = connectionsByConnector.get(connector.key) ?? [];
        return {
          key: connector.key,
          name: connector.name,
          type: connector.type,
          connectionState:
            matches.length === 0
              ? "NOT_CONNECTED"
              : matches.some((connection) => connection.status === "READY")
                ? "CONNECTED"
                : "NEEDS_ATTENTION",
          connections: joined(matches.map((connection) => connection.name)),
          scopes: joined(connector.scopes.map((scope) => scope.id)),
          defaultScopes: joined(connector.defaultScopes),
        };
      }),
      connections: active.map((connection) => ({
        name: connection.name,
        connector: connection.connectorKey,
        status: connection.status,
        showCommand: `${connectionShowCommand(connection.name)} --agentic`,
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
      ...(connection.details ? { details: connection.details } : {}),
      usage: connectionUsage(connection),
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
