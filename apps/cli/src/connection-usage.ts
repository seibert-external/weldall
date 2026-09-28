import type { ConnectionSummary } from "./services/connections.js";

export const CONNECTION_USAGE_DISCOVERY_HINT =
  "Provider-specific usage hints and request examples: weldall connections show <connection-name>.";
export const AGENTIC_CONNECTION_USAGE_DISCOVERY_HINT =
  "Provider-specific usage hints and request examples: weldall connections show <connection-name> --agentic.";

export const CONNECTION_REQUEST_INSTRUCTIONS = [
  "Use weldall request --connection <connection-name-or-id> <https-url> for provider requests.",
  "Run weldall request --help for supported methods, headers, and request bodies; do not assume curl flags are supported.",
];

/** Quote individual POSIX shell arguments; provider metadata never supplies executable commands. */
const quoteArgument = (value: string) =>
  /^[a-zA-Z0-9._:/=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;

export const connectionShowCommand = (name: string) =>
  `weldall connections show ${quoteArgument(name)}`;

/** Format structured examples using the selected connection, without any provider-specific logic. */
export function connectionUsage(connection: ConnectionSummary) {
  return {
    instructions: [...CONNECTION_REQUEST_INSTRUCTIONS, ...(connection.usage?.instructions ?? [])],
    examples: (connection.usage?.examples ?? []).map((example) => ({
      ...example,
      command: `weldall request --connection ${quoteArgument(connection.name)} --method ${quoteArgument(example.method)} ${quoteArgument(example.url)}`,
    })),
  };
}

/** Preserve legacy response shape when the server does not provide usage metadata. */
export const withConnectionUsage = (connection: ConnectionSummary) =>
  connection.usage ? { ...connection, usage: connectionUsage(connection) } : connection;
