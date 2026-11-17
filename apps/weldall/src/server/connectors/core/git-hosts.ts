import { db } from "@weldall/db";
import { ConnectorError } from "../errors";
import { getConnectorProvider } from "../registry";
import { decryptSecretEnvelope, loadSecretEnvelope } from "../encryption";
import type { GitHost } from "../git-host";

/**
 * Opens the Git host behind an enabled connector, using the one ready shared connection that
 * holds its credential. Server-internal: callers authorize the person (app registry ownership)
 * first. The credential is decrypted lazily, only when the host needs it, e.g. on a token cache miss.
 */
export async function openGitHost({ connectorId }: { connectorId: string }): Promise<GitHost> {
  const connector = await db.connector.findUnique({ where: { id: connectorId } });
  if (!connector) throw new ConnectorError("not_found", "Connector not found.", 404);
  const provider = getConnectorProvider(connector.providerType);
  if (!provider.gitHost)
    throw new ConnectorError("unsupported_provider", "This connector is not a Git host.");
  if (!connector.enabled) throw new ConnectorError("disabled", "Connector is disabled.", 409);
  const config = provider.parseConfiguration(connector.providerConfig);
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
  const connection = connections[0]!;
  provider.validateSetupInput({ config, value: connection.providerSelection });
  const grant = provider.parseGrant(connection.providerGrant);
  return provider.gitHost.open({
    config,
    async loadCredentials() {
      const credentials = provider.parseCredentials(
        JSON.parse(
          await decryptSecretEnvelope({
            ...(await loadSecretEnvelope({
              tx: db,
              id: connection.credentialId!,
              connectorId,
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
