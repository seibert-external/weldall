import { db, type Connector } from "@weldall/db";
import { ConnectorError } from "../errors";
import { getConnectorProvider } from "../registry";

/** One database claim per connector, across workers. Never reclaim an ambiguous POST after a
 * crash or timeout: an administrator must explicitly remove the failed connector to register anew.
 * Only the public client ID is stored. OAuth attempts/tokens use the selected envelope provider.
 */
export async function ensureConnectorRegistration(connector: Connector, callbackUrl: string) {
  const capability = getConnectorProvider(connector.providerType).registration;
  if (!capability) return undefined;
  const input = { config: connector.providerConfig, callbackUrl };
  const binding = capability.binding(input);
  const claimed = await db.connectorRegistration.createMany({
    data: [{ connectorId: connector.id, binding, status: "REGISTERING" }],
    skipDuplicates: true,
  });
  if (!claimed.count) {
    const existing = await db.connectorRegistration.findUnique({
      where: { connectorId: connector.id },
    });
    if (existing?.status === "READY" && existing.binding === binding && existing.clientId)
      return { clientId: existing.clientId };
    throw new ConnectorError(
      "registration_unavailable",
      "MCP registration is in progress or requires administrator review.",
      503,
    );
  }
  try {
    const registered = await capability.register(input);
    const saved = await db.connectorRegistration.updateMany({
      where: {
        connectorId: connector.id,
        status: "REGISTERING",
        binding,
        connector: { version: connector.version, enabled: true },
      },
      data: { status: "READY", clientId: registered.clientId },
    });
    if (!saved.count) throw new Error();
    return registered;
  } catch {
    await db.connectorRegistration.updateMany({
      where: { connectorId: connector.id, status: "REGISTERING", binding },
      data: { status: "FAILED" },
    });
    throw new ConnectorError(
      "registration_failed",
      "MCP registration did not complete; administrator review is required before registering again.",
      503,
    );
  }
}
