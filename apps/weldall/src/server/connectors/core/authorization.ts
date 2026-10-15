import { db, type Prisma } from "@weldall/db";
import { ConnectorError, type AuthorizedConnectorActor } from "../contracts";
import { assertConnectorAccess } from "../access";
import { runConnectorTransaction } from "../configuration";
import { getConnectorProvider } from "../registry";
import type { ConnectorProvider, ProviderGrant } from "../provider";
import { accessCredentials, findOwnedConnection } from "./connections";

type Row = Awaited<ReturnType<typeof findOwnedConnection>>;
export interface AuthorizedConnectionUse {
  row: Row;
  credentials: object;
  grant: ProviderGrant;
  provider: ConnectorProvider;
  authorizationSource: "owner";
  signal: AbortSignal;
  /** Fresh state checks immediately before each upstream dispatch; never a cache authorization. */
  assertCurrent(): Promise<void>;
}

/** The sole owner-use seam shared by HTTP proxy and MCP. Future sharing must extend this
 * authorization decision explicitly, not relax an owner query inside a transport.
 */
export async function authorizeConnectionUse<T>(input: {
  actor: AuthorizedConnectorActor;
  selector: string;
  connectorKey: string;
  signal: AbortSignal;
  preflight?: (row: Row, provider: ConnectorProvider) => void | Promise<void>;
  run: (context: AuthorizedConnectionUse) => Promise<T>;
}): Promise<T> {
  const { actor, signal } = input;
  if (actor.type === "machine" || !input.selector || input.selector.length > 160)
    throw new ConnectorError(
      "connection_denied",
      "Connection is not available to this caller.",
      403,
    );
  signal.throwIfAborted();
  const initial = await findOwnedConnection({ tx: db, selector: input.selector, actor });
  const provider = getConnectorProvider(initial.connector.providerType);
  const authorize = (row: Row, allowRefreshing = false) => {
    assertConnectorAccess({ connector: row.connector, actor });
    if (
      !row.connector.enabled ||
      (row.status !== "READY" && !(allowRefreshing && row.status === "REFRESHING")) ||
      row.connector.key !== input.connectorKey
    )
      throw new ConnectorError(
        "connection_denied",
        "Connection is not available to this caller.",
        403,
      );
    provider.validateSetupInput({
      config: row.connector.providerConfig,
      value: row.providerSelection,
    });
  };
  authorize(initial, true);
  await input.preflight?.(initial, provider);
  signal.throwIfAborted();
  await runConnectorTransaction(async (tx) => {
    const row = await findOwnedConnection({ tx, selector: initial.id, actor });
    authorize(row, true);
    const reset = row.rateWindow.getTime() <= Date.now() - 60_000;
    if (!reset && row.rateCount >= 60)
      throw new ConnectorError(
        "rate_limit",
        "Weldall connection request limit exceeded. Retry next minute.",
        429,
      );
    await tx.connection.update({
      where: { id: row.id, version: row.version },
      data: {
        rateWindow: reset ? new Date() : row.rateWindow,
        rateCount: reset ? 1 : { increment: 1 },
      },
    });
  });
  const { credentials, row } = await accessCredentials({ actor, selector: initial.id });
  authorize(row);
  let grant: ProviderGrant;
  try {
    grant = await provider.ensureGrantCurrent({
      config: row.connector.providerConfig,
      selection: row.providerSelection,
      credentials,
      previousGrant: provider.parseGrant(row.providerGrant),
    });
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "grant_mismatch")
      await db.connection.updateMany({
        where: { id: initial.id, version: row.version, status: "READY" },
        data: { status: "RECONNECT_REQUIRED", version: { increment: 1 } },
      });
    throw error;
  }
  const check = (current: Row) => {
    signal.throwIfAborted();
    authorize(current);
    if (current.version !== row.version || current.connector.version !== row.connector.version)
      throw new ConnectorError(
        "conflict",
        "Connection changed before dispatch. Reload its state.",
        409,
      );
  };
  await runConnectorTransaction(async (tx) => {
    check(await findOwnedConnection({ tx, selector: initial.id, actor }));
    await tx.connection.update({
      where: { id: row.id, version: row.version },
      data: {
        providerGrant: JSON.parse(JSON.stringify(grant)) as Prisma.InputJsonObject,
        lastUsedAt: new Date(),
        requestCount: { increment: 1 },
      },
    });
  });
  return input.run({
    row,
    credentials,
    grant,
    provider,
    authorizationSource: "owner",
    signal,
    assertCurrent: async () =>
      check(await findOwnedConnection({ tx: db, selector: row.id, actor })),
  });
}
