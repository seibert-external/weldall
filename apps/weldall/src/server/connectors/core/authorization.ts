import { db, type Prisma } from "@weldall/db";
import { ConnectorError, type AuthorizedConnectorActor } from "../contracts";
import { assertConnectorAccess } from "../access";
import { runConnectorTransaction } from "../configuration";
import { getConnectorProvider } from "../registry";
import type { ConnectorProvider, ProviderGrant } from "../provider";
import { accessCredentials } from "./connections";
import { prepareConnectionAccess, resolveUsableConnection } from "./connection-access";

type Row = Awaited<ReturnType<typeof resolveUsableConnection>>["row"];
export interface AuthorizedConnectionUse {
  row: Row;
  credentials: object;
  grant: ProviderGrant;
  provider: ConnectorProvider;
  authorizationSource: "owner" | "scope";
  credentialManagerId: string;
  actor: AuthorizedConnectorActor;
  signal: AbortSignal;
  /** Fresh state checks before dispatch/return. Shared discovery supplies its own lifetime signal. */
  assertCurrent(signal?: AbortSignal): Promise<void>;
}

/** The sole credential-use seam shared by HTTP proxy and MCP. */
export async function authorizeConnectionUse<T>(input: {
  actor: AuthorizedConnectorActor;
  selector: string;
  connectorKey: string;
  signal: AbortSignal;
  preflight?: (row: Row, provider: ConnectorProvider) => void | Promise<void>;
  run: (context: AuthorizedConnectionUse) => Promise<T>;
}): Promise<T> {
  const { actor, signal } = input;
  if (!input.selector || input.selector.length > 160)
    throw new ConnectorError(
      "connection_denied",
      "Connection is not available to this caller.",
      403,
    );
  signal.throwIfAborted();
  const { row: initial, authorizationSource } = await resolveUsableConnection({
    selector: input.selector,
    actor,
  });
  const provider = getConnectorProvider(initial.connector.providerType);
  const authorize = (row: Row, allowRefreshing = false) => {
    assertConnectorAccess({ connector: row.connector, actor });
    if (
      !row.enabled ||
      !row.credentialId ||
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
  const resolve = await prepareConnectionAccess(actor);
  await runConnectorTransaction(async (tx) => {
    const { row } = await resolve(tx, initial.id);
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
  const check = (current: Row, dispatchSignal = signal) => {
    dispatchSignal.throwIfAborted();
    authorize(current);
    if (current.version !== row.version || current.connector.version !== row.connector.version)
      throw new ConnectorError(
        "conflict",
        "Connection changed before dispatch. Reload its state.",
        409,
      );
  };
  await runConnectorTransaction(async (tx) => {
    check((await resolve(tx, initial.id)).row);
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
    authorizationSource,
    credentialManagerId: row.ownerId,
    actor,
    signal,
    assertCurrent: async (dispatchSignal = signal) => {
      check((await resolveUsableConnection({ selector: row.id, actor })).row, dispatchSignal);
      await provider.ensureGrantCurrent({
        config: row.connector.providerConfig,
        selection: row.providerSelection,
        credentials,
        previousGrant: grant,
      });
    },
  });
}
