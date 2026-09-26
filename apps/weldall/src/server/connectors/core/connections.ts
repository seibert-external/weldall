import { createHash } from "node:crypto";
import { db, type Connector, type Connection, type Prisma } from "@weldall/db";
import { z } from "zod";
import { WELDALL_ISSUER } from "../../oauth/constants";
import { logger } from "../../observability/logger";
import {
  ConnectorError,
  connectionName,
  type AuthorizedConnectorActor,
  type ConnectorActor,
} from "../contracts";
import { readConnectorSecrets, runConnectorTransaction } from "../configuration";
import { getConnectorProvider } from "../registry";
import { ProviderTokenError, RejectedProviderCredentials } from "../errors";
import type { ProviderGrant } from "../provider";
import { readSecret, saveSecret } from "../encryption";
import { writeConnectorAuditLog } from "../audit";
import {
  assertConnectorAccess,
  canAccessConnector,
  getConnectorRequiredScopeKeys,
  connectorScopeInclude,
} from "../access";
import { effectiveScopesFor } from "../../policy/resources";

type Tx = Prisma.TransactionClient;
/** Callback routing is fixed by the reviewed provider discriminator, never caller input. */
const buildCallbackUrl = (connector: Connector) =>
  `${WELDALL_ISSUER}/api/connectors/${getConnectorProvider(connector.providerType).type}/callback`;
/** Serializes opaque provider objects without teaching persistence their internal shape. */
const serializeProviderJson = (value: object): Prisma.InputJsonObject =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
/** Derives non-reversible comparison values for OAuth state and account metadata. */
const hashValue = (value: string) => createHash("sha256").update(value).digest("hex");
const attemptPayload = z
  .object({
    attempt: z.unknown(),
    credentials: z.unknown().optional(),
  })
  .strict();
export const metadataSelect = {
  id: true,
  ownerId: true,
  connectorId: true,
  name: true,
  accountId: true,
  accountName: true,
  providerSelection: true,
  providerGrant: true,
  status: true,
  version: true,
  lastUsedAt: true,
  requestCount: true,
  revocationError: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ConnectionSelect;
/**
 * Enforces owner authority for every connection workflow. Administrators may inspect or disconnect,
 * but never execute as another owner; future connection leases may extend this boundary.
 */
export function assertConnectionOwner({ ownerId, actorId }: { ownerId: string; actorId: string }) {
  if (ownerId !== actorId) throw new ConnectorError("not_found", "Connection not found.", 404);
}
/** Builds the credential-free connection representation returned by CLI and admin metadata APIs. */
export function buildConnectionMetadata({
  row,
  connector,
}: {
  row: Prisma.ConnectionGetPayload<{ select: typeof metadataSelect }>;
  connector: Connector;
}) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    connectorId: row.connectorId,
    name: row.name,
    accountId: row.accountId,
    accountName: row.accountName,
    ...getConnectorProvider(connector.providerType).describeConnection({
      selection: row.providerSelection,
      grant: row.providerGrant,
    }),
    status: row.status,
    version: row.version,
    lastUsedAt: row.lastUsedAt,
    requestCount: row.requestCount,
    revocationError: row.revocationError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    connectorKey: connector.key,
    connectorEnabled: connector.enabled,
  };
}
/** Resolves an owner-scoped connection by stable ID first and then by owner-unique name. */
export async function findOwnedConnection({
  tx,
  selector,
  actor,
}: {
  tx: Tx;
  selector: string;
  actor: ConnectorActor;
}) {
  // Stable IDs take precedence over names; a second connection's name cannot shadow an ID.
  const row =
    (await tx.connection.findFirst({
      where: { ownerId: actor.id, id: selector },
      include: { connector: { include: connectorScopeInclude } },
    })) ??
    (await tx.connection.findUnique({
      where: { ownerId_name: { ownerId: actor.id, name: selector } },
      include: { connector: { include: connectorScopeInclude } },
    }));
  if (!row) throw new ConnectorError("not_found", "Connection not found.", 404);
  assertConnectionOwner({ ownerId: row.ownerId, actorId: actor.id });
  return row;
}
/** Lists credential-free connection metadata for an owner or the administrative overview. */
export async function listConnections(actor?: ConnectorActor) {
  const rows = await db.connection.findMany({
    where: actor ? { ownerId: actor.id } : {},
    select: {
      ...metadataSelect,
      connector: true,
      owner: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map(({ connector, owner, ...row }) => ({
    ...buildConnectionMetadata({ row, connector }),
    owner,
  }));
}
/** Reads one connection for the admin detail page, independently of the bounded overview. */
export async function getConnectionDetails(id: string) {
  const result = await db.connection.findUnique({
    where: { id },
    select: { ...metadataSelect, connector: true, owner: { select: { name: true, email: true } } },
  });
  if (!result) throw new ConnectorError("not_found", "Connection not found.", 404);
  const { connector, owner, ...row } = result;
  return { ...buildConnectionMetadata({ row, connector }), owner };
}
/** Lists enabled connector catalogs and setup metadata exposed to authenticated CLI users. */
export async function listConnectors(actor: AuthorizedConnectorActor) {
  return (
    await db.connector.findMany({
      where: { enabled: true },
      include: connectorScopeInclude,
      orderBy: { key: "asc" },
    })
  )
    .filter((connector) => canAccessConnector({ connector, actor }))
    .map((connector) => ({
      key: connector.key,
      name: connector.name,
      type: getConnectorProvider(connector.providerType).type,
      requiredScopes: getConnectorRequiredScopeKeys(connector),
      ...getConnectorProvider(connector.providerType).describeSetup({
        config: connector.providerConfig,
      }),
    }));
}
/** Stops setup and execution when an administrator has disabled the connector. */
function assertConnectorEnabled(connector: Connector) {
  if (!connector.enabled) throw new ConnectorError("disabled", "Connector is disabled.", 409);
}
/** Removes an authorization attempt's encrypted OAuth payload after terminal handling. */
async function clearAuthorizationPayload({
  tx,
  id,
  payloadId,
}: {
  tx: Tx;
  id: string;
  payloadId: string | null;
}) {
  await tx.connectionAuthorization.update({ where: { id }, data: { payloadId: null } });
  if (payloadId) await tx.encryptedValue.delete({ where: { id: payloadId } });
}
/** Bounded opportunistic cleanup. Failed exchanges with retained tokens are never silently discarded. */
export async function cleanupAttempts() {
  const expired = await db.connectionAuthorization.findMany({
    where: {
      expiresAt: { lt: new Date() },
      status: { in: ["SETUP", "AUTHORIZING", "COMPLETED", "CANCELLED", "FAILED", "EXPIRED"] },
    },
    take: 50,
    orderBy: { expiresAt: "asc" },
  });
  for (const a of expired)
    await runConnectorTransaction(async (tx) => {
      const removed = await tx.connectionAuthorization.deleteMany({
        where: { id: a.id, status: a.status },
      });
      if (removed.count && a.payloadId)
        await tx.encryptedValue.delete({ where: { id: a.payloadId } });
    });
}
/** Starts an owner-scoped connection attempt and returns the short-lived browser setup URL. */
export async function startConnection({
  actor,
  input,
}: {
  actor: AuthorizedConnectorActor;
  input: { connector: string; name: string; reconnect?: string | undefined };
}) {
  await cleanupAttempts();
  return runConnectorTransaction(async (tx) => {
    const connector = await tx.connector.findUnique({
      where: { key: input.connector },
      include: connectorScopeInclude,
    });
    if (!connector) throw new ConnectorError("not_found", "Connector not found.", 404);
    assertConnectorEnabled(connector);
    assertConnectorAccess({ connector, actor });
    const prior = input.reconnect
      ? await findOwnedConnection({ tx, selector: input.reconnect, actor })
      : null;
    if (
      prior &&
      (prior.connectorId !== connector.id ||
        !["READY", "RECONNECT_REQUIRED"].includes(prior.status))
    )
      throw new ConnectorError(
        "conflict",
        "This connection cannot be reconnected in its current state.",
        409,
      );
    const name = prior?.name ?? connectionName.parse(input.name);
    if (
      !prior &&
      (await tx.connection.findUnique({ where: { ownerId_name: { ownerId: actor.id, name } } }))
    )
      throw new ConnectorError("name_exists", "Connection name already exists.", 409);
    if (
      (await tx.connectionAuthorization.count({
        where: {
          ownerId: actor.id,
          status: {
            in: ["SETUP", "AUTHORIZING", "PROCESSING", "NEEDS_REVOCATION", "REVOCATION_PENDING"],
          },
          expiresAt: { gt: new Date() },
        },
      })) >= 10
    )
      throw new ConnectorError(
        "rate_limit",
        "Too many authorization attempts. Cancel an attempt or wait for expiry.",
        429,
      );
    const attempt = await tx.connectionAuthorization.create({
      data: {
        ownerId: actor.id,
        connectorId: connector.id,
        connectorVersion: connector.version,
        connectionId: prior?.id ?? null,
        connectionVersion: prior?.version ?? null,
        name,
        providerSelection: serializeProviderJson(
          getConnectorProvider(connector.providerType).buildInitialSelection({
            config: connector.providerConfig,
            ...(prior ? { previousSelection: prior.providerSelection } : {}),
          }),
        ),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: attempt.id,
      operation: "authorization.started",
      details: { connectorId: connector.id },
    });
    // Future external resources may advertise a scope catalog or their own short-lived setup URL; no credentials need transfer.
    return {
      id: attempt.id,
      setupUrl: `${WELDALL_ISSUER}/connections/setup/${attempt.id}`,
      expiresAt: attempt.expiresAt,
    };
  });
}
/** Returns one owner's credential-free authorization attempt for CLI polling and browser setup. */
export async function getAuthorizationAttempt({
  actor,
  id,
}: {
  actor: AuthorizedConnectorActor;
  id: string;
}) {
  const a = await db.connectionAuthorization.findUnique({
    where: { id },
    include: {
      connector: { include: connectorScopeInclude },
      connection: { select: metadataSelect },
    },
  });
  if (!a) throw new ConnectorError("not_found", "Authorization attempt not found.", 404);
  assertConnectionOwner({ ownerId: a.ownerId, actorId: actor.id });
  assertConnectorAccess({ connector: a.connector, actor });
  const status =
    a.expiresAt <= new Date() && ["SETUP", "AUTHORIZING"].includes(a.status) ? "EXPIRED" : a.status;
  return {
    id: a.id,
    status,
    connector: { key: a.connector.key, name: a.connector.name, version: a.connectorVersion },
    ...getConnectorProvider(a.connector.providerType).describeSetup({
      config: a.connector.providerConfig,
      previousSelection: a.providerSelection,
    }),
    expiresAt: a.expiresAt,
    connection:
      a.status === "COMPLETED" && a.connection
        ? buildConnectionMetadata({ row: a.connection, connector: a.connector })
        : null,
  };
}
/** Validates owner setup through the provider and binds its authorization attempt to this owner. */
export async function submitScopeSelection({
  actor,
  id,
  selection,
}: {
  actor: AuthorizedConnectorActor;
  id: string;
  selection: unknown;
}) {
  return runConnectorTransaction(async (tx) => {
    const a = await tx.connectionAuthorization.findUniqueOrThrow({
      where: { id },
      include: { connector: { include: connectorScopeInclude } },
    });
    assertConnectionOwner({ ownerId: a.ownerId, actorId: actor.id });
    assertConnectorEnabled(a.connector);
    assertConnectorAccess({ connector: a.connector, actor });
    if (
      a.status !== "SETUP" ||
      a.expiresAt <= new Date() ||
      a.connectorVersion !== a.connector.version
    )
      throw new ConnectorError(
        "stale_attempt",
        "Setup expired or configuration changed. Start again.",
        409,
      );
    const provider = getConnectorProvider(a.connector.providerType);
    const validated = provider.validateSetupInput({
      config: a.connector.providerConfig,
      value: selection,
    });
    const authorization = await provider.beginAuthorization({
      config: a.connector.providerConfig,
      secrets: readConnectorSecrets(a.connector),
      selection: validated,
      callbackUrl: buildCallbackUrl(a.connector),
    });
    const payload = await saveSecret({
      tx,
      provider: a.connector.envelopeProvider,
      context: `attempt:${id}:oauth`,
      value: JSON.stringify({ attempt: authorization.attempt }),
    });
    await tx.connectionAuthorization.update({
      where: { id, status: "SETUP" },
      data: {
        providerSelection: serializeProviderJson(validated),
        stateHash: hashValue(authorization.state),
        payloadId: payload.id,
        status: "AUTHORIZING",
      },
    });
    return { url: authorization.url };
  });
}
/**
 * Completes the OAuth callback outside a database transaction after claiming single-use state, then
 * revalidates connector policy and revisions when committing the resulting connection.
 */
export async function completeConnection({
  state,
  code,
  cancelled,
}: {
  state: string;
  code: string | null;
  cancelled: boolean;
}) {
  const pending = await db.connectionAuthorization.findUnique({
    where: { stateHash: hashValue(state) },
    include: {
      connector: { include: connectorScopeInclude },
      owner: { select: { email: true, emailVerified: true } },
    },
  });
  if (
    !pending ||
    !pending.owner.emailVerified ||
    pending.status !== "AUTHORIZING" ||
    pending.expiresAt <= new Date() ||
    pending.connectorVersion !== pending.connector.version
  )
    throw new ConnectorError("stale_attempt", "Authorization expired or already used.", 409);
  const scopeActor: AuthorizedConnectorActor = {
    id: pending.ownerId,
    email: pending.owner.email,
    requestId: pending.id,
    scopeKeys: await effectiveScopesFor(pending.owner.email),
  };
  assertConnectorAccess({ connector: pending.connector, actor: scopeActor });
  const claimed = await runConnectorTransaction(async (tx) => {
    const a = await tx.connectionAuthorization.findUnique({
      where: { stateHash: hashValue(state) },
      include: { connector: { include: connectorScopeInclude } },
    });
    if (
      !a ||
      a.status !== "AUTHORIZING" ||
      a.expiresAt <= new Date() ||
      a.connectorVersion !== a.connector.version ||
      !a.payloadId
    )
      throw new ConnectorError("stale_attempt", "Authorization expired or already used.", 409);
    assertConnectorEnabled(a.connector);
    assertConnectorAccess({ connector: a.connector, actor: scopeActor });
    await tx.connectionAuthorization.update({
      where: { id: a.id, status: "AUTHORIZING" },
      data: { status: cancelled ? "CANCELLED" : "PROCESSING", stateHash: null },
    });
    const payload = attemptPayload.parse(
      JSON.parse(await readSecret({ tx, id: a.payloadId, context: `attempt:${a.id}:oauth` })),
    );
    if (cancelled) {
      await clearAuthorizationPayload({ tx, id: a.id, payloadId: a.payloadId });
      return null;
    }
    return { a, payload, secrets: readConnectorSecrets(a.connector) };
  });
  if (!claimed) return "cancelled" as const;
  const { a, payload } = claimed;
  const actor = { id: a.ownerId, requestId: a.id };
  const provider = getConnectorProvider(a.connector.providerType);
  let result: Awaited<ReturnType<typeof provider.completeAuthorization>>;
  try {
    if (!code) throw new ConnectorError("invalid_callback", "Authorization code missing.");
    result = await provider.completeAuthorization({
      config: a.connector.providerConfig,
      secrets: claimed.secrets,
      selection: a.providerSelection,
      callback: new URLSearchParams({ code }),
      attempt: payload.attempt,
      callbackUrl: buildCallbackUrl(a.connector),
    });
  } catch (error) {
    logger.error(
      {
        event: "connector.connection.completion.failed",
        provider: provider.type,
        phase: "provider_authorization",
        authorizationId: a.id,
        connectorId: a.connectorId,
        error: { code: error instanceof ConnectorError ? error.code : "provider_error" },
      },
      "Connector provider authorization failed",
    );
    await runConnectorTransaction(async (tx) => {
      if (error instanceof RejectedProviderCredentials) {
        await saveSecret({
          tx,
          provider: a.connector.envelopeProvider,
          context: `attempt:${a.id}:oauth`,
          value: JSON.stringify({ ...payload, credentials: error.credentials }),
          id: a.payloadId,
        });
        await tx.connectionAuthorization.update({
          where: { id: a.id },
          data: { status: "NEEDS_REVOCATION" },
        });
      } else {
        await tx.connectionAuthorization.update({
          where: { id: a.id },
          data: { status: "FAILED" },
        });
        await clearAuthorizationPayload({ tx, id: a.id, payloadId: a.payloadId });
      }
      await writeConnectorAuditLog({
        tx,
        actor,
        event: "lifecycle",
        subjectId: a.id,
        operation: "authorization.failed",
        outcome: "failed",
      });
    });
    return "failed" as const;
  }
  // Preserve newly received credentials before policy validation, so a rejected callback has an explicit revocation path.
  await runConnectorTransaction(async (tx) => {
    await saveSecret({
      tx,
      provider: a.connector.envelopeProvider,
      context: `attempt:${a.id}:oauth`,
      value: JSON.stringify({ ...payload, credentials: result.credentials }),
      id: a.payloadId,
    });
    await tx.connectionAuthorization.update({
      where: { id: a.id, status: "PROCESSING" },
      data: { status: "NEEDS_REVOCATION" },
    });
  });
  try {
    await runConnectorTransaction(async (tx) => {
      const fresh = await tx.connectionAuthorization.findUniqueOrThrow({
        where: { id: a.id },
        include: { connector: { include: connectorScopeInclude } },
      });
      assertConnectorEnabled(fresh.connector);
      assertConnectorAccess({ connector: fresh.connector, actor: scopeActor });
      if (
        fresh.status !== "NEEDS_REVOCATION" ||
        fresh.connectorVersion !== fresh.connector.version ||
        fresh.expiresAt <= new Date()
      )
        throw new ConnectorError("stale_attempt", "Authorization expired or policy changed.", 409);
      provider.validateSetupInput({
        config: fresh.connector.providerConfig,
        value: fresh.providerSelection,
      });
      // CompleteAuthorization checked exact consent against this pinned configuration revision.
      const grant = provider.parseGrant(result.grant);
      const prior = fresh.connectionId
        ? await tx.connection.findUniqueOrThrow({ where: { id: fresh.connectionId } })
        : null;
      if (
        prior &&
        (prior.version !== fresh.connectionVersion ||
          !["READY", "RECONNECT_REQUIRED"].includes(prior.status) ||
          prior.accountId !== result.accountId)
      )
        throw new ConnectorError(
          "stale_connection",
          "Connection changed or a different provider account was selected.",
          409,
        );
      const row =
        prior ??
        (await tx.connection.create({
          data: {
            ownerId: fresh.ownerId,
            connectorId: fresh.connectorId,
            name: fresh.name,
            accountId: result.accountId,
            accountName: result.accountName,
            providerSelection: fresh.providerSelection as Prisma.InputJsonValue,
            providerGrant: serializeProviderJson(grant),
          },
        }));
      const secret = await saveSecret({
        tx,
        provider: fresh.connector.envelopeProvider,
        context: `connection:${row.id}:credentials`,
        value: JSON.stringify(result.credentials),
        id: row.credentialId,
      });
      await tx.connection.update({
        where: { id: row.id, version: row.version },
        data: {
          credentialId: secret.id,
          status: "READY",
          providerSelection: fresh.providerSelection as Prisma.InputJsonValue,
          providerGrant: serializeProviderJson(grant),
          accountName: result.accountName,
          refreshStartedAt: null,
          revocationError: null,
          version: { increment: 1 },
        },
      });
      await tx.connectionAuthorization.update({
        where: { id: a.id },
        data: { status: "COMPLETED", connectionId: row.id },
      });
      await clearAuthorizationPayload({ tx, id: a.id, payloadId: a.payloadId });
      await writeConnectorAuditLog({
        tx,
        actor,
        event: "lifecycle",
        subjectId: row.id,
        operation: prior ? "connection.reconnected" : "connection.connected",
        details: { connectorId: row.connectorId, accountId: row.accountId },
      });
    });
    return "success" as const;
  } catch (error) {
    logger.error(
      {
        event: "connector.connection.completion.failed",
        provider: provider.type,
        phase: "grant_validation_or_persistence",
        authorizationId: a.id,
        connectorId: a.connectorId,
        error: { code: error instanceof ConnectorError ? error.code : "persistence_error" },
      },
      "Connector grant validation or persistence failed",
    );
    await writeConnectorAuditLog({
      tx: db,
      actor,
      event: "lifecycle",
      subjectId: a.id,
      operation: "authorization.cleanup_required",
      outcome: "failed",
    });
    return "failed" as const;
  }
}
/** Cancels an authorization attempt and revokes any retained provider grant before local cleanup. */
export async function cancelAuthorizationAttempt({
  actor,
  id,
  administrator = false,
}: {
  actor: ConnectorActor;
  id: string;
  administrator?: boolean;
}) {
  const a = await db.connectionAuthorization.findUniqueOrThrow({
    where: { id },
    include: { connector: true },
  });
  if (!administrator) assertConnectionOwner({ ownerId: a.ownerId, actorId: actor.id });
  if (a.status === "COMPLETED")
    throw new ConnectorError("completed", "Disconnect the completed connection instead.", 409);
  if (a.status === "PROCESSING")
    throw new ConnectorError(
      "in_progress",
      "Provider exchange is in progress or was interrupted. Check status; expired interrupted exchanges require administrator review of the provider grant.",
      409,
    );
  let expectedStatus = a.status;
  if (["NEEDS_REVOCATION", "REVOCATION_PENDING"].includes(a.status) && a.payloadId) {
    const claimed = await db.connectionAuthorization.updateMany({
      where: { id, status: a.status },
      data: { status: "REVOCATION_PENDING", stateHash: null },
    });
    if (!claimed.count) throw new ConnectorError("conflict", "Authorization changed; reload.", 409);
    expectedStatus = "REVOCATION_PENDING";
    const value = attemptPayload.parse(
      JSON.parse(await readSecret({ tx: db, id: a.payloadId, context: `attempt:${id}:oauth` })),
    );
    try {
      if (value.credentials) {
        const remote = await getConnectorProvider(a.connector.providerType).disconnectGrant({
          config: a.connector.providerConfig,
          secrets: readConnectorSecrets(a.connector),
          credentials: value.credentials,
        });
        if (remote.status !== "revoked")
          throw new ConnectorError(
            "revocation_unconfirmed",
            "Provider revocation is unconfirmed.",
            502,
          );
      }
    } catch (error) {
      await writeConnectorAuditLog({
        tx: db,
        actor,
        event: "lifecycle",
        subjectId: id,
        operation: "authorization.revocation_unconfirmed",
        outcome: "failed",
      });
      throw error;
    }
  }
  await runConnectorTransaction(async (tx) => {
    const removed = await tx.connectionAuthorization.updateMany({
      where: { id, status: expectedStatus },
      data: { status: "CANCELLED", stateHash: null },
    });
    if (!removed.count) throw new ConnectorError("conflict", "Authorization changed; reload.", 409);
    await clearAuthorizationPayload({ tx, id, payloadId: a.payloadId });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: id,
      operation: "authorization.cancelled",
    });
  });
}
/** Decrypts only owner-authorized state and delegates credential validation to its provider. */
async function readStoredCredentials({
  tx,
  connection,
  connector,
}: {
  tx: Tx;
  connection: Connection;
  connector: Connector;
}) {
  if (!connection.credentialId)
    throw new ConnectorError("reconnect_required", "Reconnect this connection.", 409);
  return getConnectorProvider(connector.providerType).parseCredentials(
    JSON.parse(
      await readSecret({
        tx,
        id: connection.credentialId,
        context: `connection:${connection.id}:credentials`,
      }),
    ),
  );
}
/**
 * Returns usable credentials for proxy execution, using a persisted compare-and-set as the
 * cross-process refresh claim; ambiguous outcomes require reconnect instead of blind retries.
 */
export async function accessCredentials({
  actor,
  selector,
}: {
  actor: AuthorizedConnectorActor;
  selector: string;
}) {
  const claim = await runConnectorTransaction(async (tx) => {
    const row = await findOwnedConnection({ tx, selector, actor });
    assertConnectorEnabled(row.connector);
    assertConnectorAccess({ connector: row.connector, actor });
    if (
      row.status === "REFRESHING" &&
      row.refreshStartedAt &&
      row.refreshStartedAt.getTime() < Date.now() - 30_000
    ) {
      await tx.connection.update({
        where: { id: row.id, version: row.version },
        data: { status: "RECONNECT_REQUIRED", version: { increment: 1 } },
      });
      return null;
    }
    if (row.status !== "READY")
      throw new ConnectorError(
        "connection_unavailable",
        "Connection is not ready. Retry after an in-progress refresh or reconnect.",
        409,
      );
    const provider = getConnectorProvider(row.connector.providerType);
    provider.validateSetupInput({
      config: row.connector.providerConfig,
      value: row.providerSelection,
    });
    const credentials = await readStoredCredentials({
      tx,
      connection: row,
      connector: row.connector,
    });
    if (!provider.needsRefresh(credentials)) return { row, credentials, refresh: false as const };
    const updated = await tx.connection.update({
      where: { id: row.id, version: row.version, status: "READY" },
      data: { status: "REFRESHING", refreshStartedAt: new Date(), version: { increment: 1 } },
    });
    return {
      row: { ...updated, connector: row.connector },
      credentials,
      refresh: true as const,
      secrets: readConnectorSecrets(row.connector),
    };
  });
  if (!claim)
    throw new ConnectorError(
      "reconnect_required",
      "Interrupted refresh; reconnect to recover safely.",
      409,
    );
  if (!claim.refresh) return claim;
  try {
    const provider = getConnectorProvider(claim.row.connector.providerType);
    let credentials: object;
    let grant: ProviderGrant | undefined;
    try {
      const result = await provider.refreshCredentials({
        config: claim.row.connector.providerConfig,
        secrets: claim.secrets,
        selection: claim.row.providerSelection,
        credentials: claim.credentials,
        previousGrant: provider.parseGrant(claim.row.providerGrant),
      });
      credentials = result.credentials;
      grant = result.grant;
    } catch (error) {
      if (!(error instanceof RejectedProviderCredentials)) throw error;
      credentials = error.credentials;
    }
    const refreshed = await runConnectorTransaction(async (tx) => {
      const row = await tx.connection.findUniqueOrThrow({
        where: { id: claim.row.id },
        include: { connector: { include: connectorScopeInclude } },
      });
      // Disconnect can block the account while refresh is in flight. Retain a rotated token solely for manual revocation.
      const pending =
        row.status === "REVOCATION_PENDING" &&
        row.refreshStartedAt?.getTime() === claim.row.refreshStartedAt?.getTime();
      if (!pending && (row.status !== "REFRESHING" || row.version !== claim.row.version))
        throw new ConnectorError("conflict", "Connection changed during refresh.", 409);
      await saveSecret({
        tx,
        provider: row.connector.envelopeProvider,
        context: `connection:${row.id}:credentials`,
        value: JSON.stringify(credentials),
        id: row.credentialId,
      });
      // Never perform provider I/O in this transaction; execution checks freshness before dispatch.
      const usable = Boolean(grant) && row.connector.version === claim.row.connector.version;
      await tx.connection.update({
        where: { id: row.id, version: row.version },
        data: {
          status: pending ? "REVOCATION_PENDING" : usable ? "READY" : "RECONNECT_REQUIRED",
          ...(usable && grant ? { providerGrant: serializeProviderJson(grant) } : {}),
          refreshStartedAt: null,
          version: { increment: 1 },
        },
      });
      await writeConnectorAuditLog({
        tx,
        actor,
        event: "lifecycle",
        subjectId: row.id,
        operation: "connection.refreshed",
      });
      return tx.connection.findUniqueOrThrow({
        where: { id: row.id },
        include: { connector: { include: connectorScopeInclude } },
      });
    });
    return { row: refreshed, credentials, refresh: false as const };
  } catch (error) {
    await recordRefreshFailure({
      id: claim.row.id,
      version: claim.row.version,
      actor,
      authorizationLost: error instanceof ProviderTokenError && error.authorizationLost,
      retryable: error instanceof ProviderTokenError && error.retryable,
    });
    throw new ConnectorError(
      "refresh_failed",
      "Refresh failed. Check connection status; reconnect if required.",
      502,
    );
  }
}
/** Records a failed refresh claim so subsequent proxy requests observe a safe connection state. */
async function recordRefreshFailure({
  id,
  version,
  actor,
  authorizationLost,
  retryable,
}: {
  id: string;
  version: number;
  actor: ConnectorActor;
  authorizationLost: boolean;
  retryable: boolean;
}) {
  await runConnectorTransaction(async (tx) => {
    await tx.connection.updateMany({
      where: { id, version, status: "REFRESHING" },
      data: {
        status: retryable ? "READY" : "RECONNECT_REQUIRED",
        refreshStartedAt: null,
        version: { increment: 1 },
      },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: id,
      operation: authorizationLost
        ? "refresh.authorization_lost"
        : retryable
          ? "refresh.transient_failure"
          : "refresh.outcome_uncertain",
      outcome: "failed",
    });
  });
}
/**
 * Blocks a connection before provider I/O, revokes every retained provider grant, and removes all
 * local connection state. Revocation is best-effort, while audit records preserve whether the provider
 * confirmed it.
 */
async function disconnectAndDelete({
  actor,
  selector,
  administrator,
}: {
  actor: ConnectorActor;
  selector: string;
  administrator: boolean;
}) {
  const claim = await runConnectorTransaction(async (tx) => {
    const row = administrator
      ? await tx.connection.findUniqueOrThrow({
          where: { id: selector },
          include: { connector: true },
        })
      : await findOwnedConnection({ tx, selector, actor });
    const attempts = await tx.connectionAuthorization.findMany({
      where: { connectionId: row.id },
    });
    const blocked = await tx.connection.update({
      where: { id: row.id, version: row.version },
      data: {
        status: "REVOCATION_PENDING",
        version: { increment: 1 },
        revocationError: administrator
          ? "Administrative disconnect in progress; provider revocation unconfirmed."
          : "Provider revocation unconfirmed; explicit retry may be required.",
      },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: row.id,
      operation: "disconnect.blocked",
    });
    const processing =
      Boolean(row.refreshStartedAt && row.refreshStartedAt.getTime() > Date.now() - 30_000) ||
      attempts.some(
        (attempt) =>
          attempt.status === "PROCESSING" && attempt.expiresAt.getTime() + 30_000 > Date.now(),
      );
    if (processing) return { row, attempts, version: blocked.version, processing };

    // Stop callbacks before provider I/O. Retained grants stay marked for explicit retry.
    await tx.connectionAuthorization.updateMany({
      where: { connectionId: row.id, status: { in: ["SETUP", "AUTHORIZING"] } },
      data: { status: "CANCELLED", stateHash: null },
    });
    await tx.connectionAuthorization.updateMany({
      where: { connectionId: row.id, status: "NEEDS_REVOCATION" },
      data: { status: "REVOCATION_PENDING", stateHash: null },
    });
    return {
      row,
      attempts: await tx.connectionAuthorization.findMany({
        where: { connectionId: row.id },
      }),
      version: blocked.version,
      processing,
    };
  });
  if (claim.processing) {
    const message =
      "Token processing is still in progress. Retry disconnect after it finishes or expires.";
    if (!administrator) return { deleted: false as const, message };
    throw new ConnectorError("in_progress", `Connection blocked. ${message}`, 409);
  }

  const credentialsToRevoke: object[] = [];
  const provider = getConnectorProvider(claim.row.connector.providerType);
  let revocationConfirmed = claim.row.credentialId !== null;
  if (claim.row.refreshStartedAt) revocationConfirmed = false;
  if (claim.row.credentialId) {
    try {
      credentialsToRevoke.push(
        await readStoredCredentials({
          tx: db,
          connection: claim.row,
          connector: claim.row.connector,
        }),
      );
    } catch {
      revocationConfirmed = false;
    }
  }
  for (const attempt of claim.attempts) {
    if (!attempt.payloadId) {
      if (["NEEDS_REVOCATION", "REVOCATION_PENDING"].includes(attempt.status))
        revocationConfirmed = false;
      continue;
    }
    try {
      const payload = attemptPayload.parse(
        JSON.parse(
          await readSecret({
            tx: db,
            id: attempt.payloadId,
            context: `attempt:${attempt.id}:oauth`,
          }),
        ),
      );
      if (payload.credentials)
        credentialsToRevoke.push(provider.parseCredentials(payload.credentials));
      else if (["NEEDS_REVOCATION", "REVOCATION_PENDING"].includes(attempt.status))
        revocationConfirmed = false;
    } catch {
      revocationConfirmed = false;
    }
  }
  for (const credentials of credentialsToRevoke) {
    try {
      const remote = await provider.disconnectGrant({
        config: claim.row.connector.providerConfig,
        secrets: readConnectorSecrets(claim.row.connector),
        credentials,
      });
      if (remote.status !== "revoked") revocationConfirmed = false;
    } catch {
      revocationConfirmed = false;
    }
  }
  await runConnectorTransaction(async (tx) => {
    // A refresh or concurrent owner operation may have changed the tokens while we contacted the provider.
    await tx.connection.findUniqueOrThrow({
      where: {
        id: claim.row.id,
        version: claim.version,
        status: "REVOCATION_PENDING",
      },
    });
    const attempts = await tx.connectionAuthorization.findMany({
      where: { connectionId: claim.row.id },
    });
    if (
      attempts.length !== claim.attempts.length ||
      attempts.some((attempt) => {
        const prior = claim.attempts.find(({ id }) => id === attempt.id);
        return !prior || prior.payloadId !== attempt.payloadId || prior.status !== attempt.status;
      })
    )
      throw new ConnectorError("conflict", "Connection setup changed; retry Disconnect.", 409);
    await tx.connectionAuthorization.deleteMany({ where: { connectionId: claim.row.id } });
    await tx.connection.delete({ where: { id: claim.row.id, version: claim.version } });
    const valueIds = [
      claim.row.credentialId,
      ...claim.attempts.map((attempt) => attempt.payloadId),
    ].filter((value): value is string => value !== null);
    await tx.encryptedValue.deleteMany({ where: { id: { in: valueIds } } });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: claim.row.id,
      operation: revocationConfirmed
        ? "disconnect.deleted_revocation_confirmed"
        : "disconnect.deleted_revocation_unconfirmed",
      outcome: revocationConfirmed ? "success" : "failed",
      details: { connectorId: claim.row.connectorId, accountId: claim.row.accountId },
    });
  });
  return {
    deleted: true as const,
    revocationConfirmed,
    ...(revocationConfirmed
      ? {}
      : {
          message:
            "Connection removed from Weldall, but provider revocation was unconfirmed. Remove access in provider account settings.",
        }),
  };
}

/** Best-effort revokes and deletes one owner-selected connection. */
export async function disconnectConnection({
  actor,
  selector,
}: {
  actor: ConnectorActor;
  selector: string;
}) {
  const result = await disconnectAndDelete({
    actor,
    selector,
    administrator: false,
  });
  return result.deleted
    ? {
        status: "DISCONNECTED",
        revocationConfirmed: result.revocationConfirmed,
        ...(result.message ? { message: result.message } : {}),
      }
    : { status: "REVOCATION_PENDING", message: result.message };
}

/** Admin Disconnect permanently removes a connection after best-effort provider revocation. */
export async function disconnectAndDeleteConnection({
  actor,
  id,
}: {
  actor: ConnectorActor;
  id: string;
}) {
  const result = await disconnectAndDelete({
    actor,
    selector: id,
    administrator: true,
  });
  if (!result.deleted)
    throw new ConnectorError("in_progress", "Connection removal is still in progress.", 409);
  return { revocationConfirmed: result.revocationConfirmed };
}
