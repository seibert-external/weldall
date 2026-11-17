import { db, type Connection, type Connector } from "@weldall/db";
import { ConnectorError } from "../errors";
import { getConnectorProvider } from "../registry";
import { decryptSecretEnvelope, loadSecretEnvelope } from "../encryption";
import type { GitHost } from "../git-host";
import type { ConnectorProvider } from "../provider";

type GitHostProvider = ConnectorProvider & {
  gitHost: NonNullable<ConnectorProvider["gitHost"]>;
};

/** The provider of a Git host connector; fails for other connector types. */
export function gitHostProvider(connector: Connector): GitHostProvider {
  const provider = getConnectorProvider(connector.providerType);
  if (!provider.gitHost)
    throw new ConnectorError("unsupported_provider", "This connector is not a Git host.");
  return provider as GitHostProvider;
}

/**
 * Opens the host with the credential of `connection`, decrypted lazily, only when the host needs
 * it (e.g. on a token cache miss). Without a connection, every credential use fails with
 * `credential_unavailable`, or with `credential_ambiguous` when several enabled shared
 * connections hold one, so that the caller can report the real cause.
 */
export function openGitHostWith({
  provider,
  connector,
  connection,
  ambiguous = false,
}: {
  provider: GitHostProvider;
  connector: Connector;
  connection: Connection | null;
  ambiguous?: boolean;
}): GitHost {
  const config = provider.parseConfiguration(connector.providerConfig);
  if (connection) provider.validateSetupInput({ config, value: connection.providerSelection });
  const grant = connection?.credentialId ? provider.parseGrant(connection.providerGrant) : null;
  return provider.gitHost.open({
    config,
    async loadCredentials() {
      if (!connection && ambiguous)
        throw new ConnectorError(
          "credential_ambiguous",
          "More than one enabled shared connection provides this Git host's credential. Keep one enabled.",
          503,
        );
      if (!connection?.credentialId || !grant)
        throw new ConnectorError(
          "credential_unavailable",
          "Provision the Git host's credential on a shared connection.",
          503,
        );
      const credentials = provider.parseCredentials(
        JSON.parse(
          await decryptSecretEnvelope({
            ...(await loadSecretEnvelope({
              tx: db,
              id: connection.credentialId,
              connectorId: connector.id,
            })),
            context: `connection:${connection.id}:credentials`,
          }),
        ),
      );
      await provider.ensureGrantCurrent({
        config,
        selection: connection.providerSelection,
        credentials,
        previousGrant: grant,
      });
      return credentials;
    },
  });
}

/**
 * Opens the Git host behind an enabled connector, using the one ready shared connection that
 * holds its credential. Server-internal: callers authorize the person (app registry ownership)
 * first. The credential is decrypted lazily, only when the host needs it, e.g. on a token cache miss.
 */
export async function openGitHost({ connectorId }: { connectorId: string }): Promise<GitHost> {
  const connector = await db.connector.findUnique({ where: { id: connectorId } });
  if (!connector) throw new ConnectorError("not_found", "Connector not found.", 404);
  const provider = gitHostProvider(connector);
  if (!connector.enabled) throw new ConnectorError("disabled", "Connector is disabled.", 409);
  const connections = await db.connection.findMany({
    where: {
      connectorId,
      accessMode: "SCOPED",
      enabled: true,
      status: "READY",
      credentialId: { not: null },
    },
    take: 2,
  });
  if (connections.length !== 1)
    throw new ConnectorError(
      "credential_unavailable",
      connections.length
        ? "More than one shared connection provides this Git host's credential. Keep one enabled."
        : "Provision the Git host's credential on an enabled shared connection.",
      503,
    );
  return openGitHostWith({ provider, connector, connection: connections[0]! });
}
