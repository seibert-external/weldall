import { createHash, randomBytes } from "node:crypto";
import { db, type Connector, type Connection, type Prisma } from "@weldall/db";
import { z } from "zod";
import { WELDALL_ISSUER } from "../oauth/constants";
import { ConnectorError, connectionName, type ConnectorActor } from "./contracts";
import { readConnectorClientSecret, runConnectorTransaction } from "./configuration";
import {
  calculateEffectiveCapabilities,
  listAvailableScopes,
  normalizeGrants,
  requiredScopes,
  shouldReconnectAfterRefresh,
  validateSelectedScopes,
} from "./scopes";
import { readSecret, saveSecret } from "./encryption";
import {
  buildGoogleAuthorizationUrl,
  completeGoogleAuthorization,
  credentialsSchema,
  refreshGoogleCredentials,
  revokeGoogleAuthorization,
  GoogleTokenError,
} from "./google";
import { writeConnectorAuditLog } from "./audit";

type Tx = Prisma.TransactionClient;
const callback = `${WELDALL_ISSUER}/api/connectors/google/callback`;
/** Derives non-reversible comparison values for OAuth state and account metadata. */
const hashValue = (value: string) => createHash("sha256").update(value).digest("hex");
/** Creates short-lived high-entropy values for OAuth state, nonce, and PKCE flows. */
const createRandomToken = () => randomBytes(32).toString("base64url");
const attemptPayload = z.object({
  verifier: z.string(),
  nonce: z.string(),
  credentials: credentialsSchema.optional(),
});
export const metadataSelect = {
  id: true,
  ownerId: true,
  connectorId: true,
  name: true,
  accountId: true,
  accountName: true,
  selectedScopes: true,
  grantedScopes: true,
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
    selectedScopes: row.selectedScopes,
    grantedScopes: row.grantedScopes,
    status: row.status,
    version: row.version,
    lastUsedAt: row.lastUsedAt,
    requestCount: row.requestCount,
    revocationError: row.revocationError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    capabilities:
      connector.enabled && row.status === "READY"
        ? calculateEffectiveCapabilities({
            config: connector,
            selected: row.selectedScopes,
            granted: row.grantedScopes,
          })
        : [],
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
      include: { connector: true },
    })) ??
    (await tx.connection.findUnique({
      where: { ownerId_name: { ownerId: actor.id, name: selector } },
      include: { connector: true },
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
/** Lists enabled connector catalogs and setup metadata exposed to authenticated CLI users. */
export async function listConnectors() {
  return (await db.connector.findMany({ where: { enabled: true }, orderBy: { key: "asc" } })).map(
    (c) => ({
      key: c.key,
      name: c.name,
      type: c.type,
      scopes: listAvailableScopes(c),
      defaultScopes: c.defaultScopes,
      requestPrefix: `${WELDALL_ISSUER}/connectors/${c.key}/`,
    }),
  );
}
/** Reads the encrypted OAuth client secret required for a server-side Google exchange. */
function readGoogleClient(connector: Connector) {
  return { clientId: connector.clientId, clientSecret: readConnectorClientSecret(connector) };
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
  actor: ConnectorActor;
  input: { connector: string; name: string; reconnect?: string | undefined };
}) {
  await cleanupAttempts();
  return runConnectorTransaction(async (tx) => {
    const connector = await tx.connector.findUnique({ where: { key: input.connector } });
    if (!connector) throw new ConnectorError("not_found", "Connector not found.", 404);
    assertConnectorEnabled(connector);
    const prior = input.reconnect
      ? await findOwnedConnection({ tx, selector: input.reconnect, actor })
      : null;
    if (
      prior &&
      (prior.connectorId !== connector.id ||
        !["READY", "RECONNECT_REQUIRED", "DISCONNECTED"].includes(prior.status))
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
        selectedScopes: [
          ...requiredScopes,
          ...(prior
            ? prior.selectedScopes.filter((s) => connector.allowedScopes.includes(s))
            : connector.defaultScopes),
        ],
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
  actor: ConnectorActor;
  id: string;
}) {
  const a = await db.connectionAuthorization.findUnique({
    where: { id },
    include: { connector: true, connection: { select: metadataSelect } },
  });
  if (!a) throw new ConnectorError("not_found", "Authorization attempt not found.", 404);
  assertConnectionOwner({ ownerId: a.ownerId, actorId: actor.id });
  const status =
    a.expiresAt <= new Date() && ["SETUP", "AUTHORIZING"].includes(a.status) ? "EXPIRED" : a.status;
  return {
    id: a.id,
    status,
    connector: { key: a.connector.key, name: a.connector.name, version: a.connectorVersion },
    scopes: listAvailableScopes(a.connector),
    selectedScopes: a.selectedScopes,
    capabilities: calculateEffectiveCapabilities({
      config: a.connector,
      selected: a.selectedScopes,
      granted: a.selectedScopes,
    }),
    expiresAt: a.expiresAt,
    connection:
      a.status === "COMPLETED" && a.connection
        ? buildConnectionMetadata({ row: a.connection, connector: a.connector })
        : null,
  };
}
/** Persists owner scope selection and creates the PKCE-protected Google authorization URL. */
export async function submitScopeSelection({
  actor,
  id,
  selected,
}: {
  actor: ConnectorActor;
  id: string;
  selected: string[];
}) {
  return runConnectorTransaction(async (tx) => {
    const a = await tx.connectionAuthorization.findUniqueOrThrow({
      where: { id },
      include: { connector: true },
    });
    assertConnectionOwner({ ownerId: a.ownerId, actorId: actor.id });
    assertConnectorEnabled(a.connector);
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
    const scopes = validateSelectedScopes({ config: a.connector, selected });
    const state = createRandomToken(),
      verifier = createRandomToken(),
      nonce = createRandomToken();
    const payload = await saveSecret({
      tx,
      provider: a.connector.envelopeProvider,
      context: `attempt:${id}:oauth`,
      value: JSON.stringify({ verifier, nonce }),
    });
    await tx.connectionAuthorization.update({
      where: { id, status: "SETUP" },
      data: {
        selectedScopes: scopes,
        stateHash: hashValue(state),
        payloadId: payload.id,
        status: "AUTHORIZING",
      },
    });
    return {
      url: buildGoogleAuthorizationUrl({
        clientId: a.connector.clientId,
        redirectUri: callback,
        state,
        nonce,
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        selected: scopes,
      }),
    };
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
  const claimed = await runConnectorTransaction(async (tx) => {
    const a = await tx.connectionAuthorization.findUnique({
      where: { stateHash: hashValue(state) },
      include: { connector: true },
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
    return { a, payload, client: readGoogleClient(a.connector) };
  });
  if (!claimed) return "cancelled" as const;
  const { a, payload } = claimed;
  const actor = { id: a.ownerId, requestId: a.id };
  let result: Awaited<ReturnType<typeof completeGoogleAuthorization>>;
  try {
    if (!code) throw new ConnectorError("invalid_callback", "Authorization code missing.");
    result = await completeGoogleAuthorization({
      client: claimed.client,
      input: {
        code,
        redirectUri: callback,
        nonce: payload.nonce,
        verifier: payload.verifier,
      },
    });
  } catch {
    await runConnectorTransaction(async (tx) => {
      await tx.connectionAuthorization.update({ where: { id: a.id }, data: { status: "FAILED" } });
      await clearAuthorizationPayload({ tx, id: a.id, payloadId: a.payloadId });
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
        include: { connector: true },
      });
      assertConnectorEnabled(fresh.connector);
      if (
        fresh.status !== "NEEDS_REVOCATION" ||
        fresh.connectorVersion !== fresh.connector.version ||
        fresh.expiresAt <= new Date()
      )
        throw new ConnectorError("stale_attempt", "Authorization expired or policy changed.", 409);
      validateSelectedScopes({ config: fresh.connector, selected: fresh.selectedScopes });
      const grants = normalizeGrants(result.credentials.grantedScopes);
      if (
        requiredScopes.some((s) => !grants.includes(s)) ||
        !calculateEffectiveCapabilities({
          config: fresh.connector,
          selected: fresh.selectedScopes,
          granted: grants,
        }).length
      )
        throw new ConnectorError(
          "missing_grants",
          "Google did not grant required identity and API permissions.",
        );
      const prior = fresh.connectionId
        ? await tx.connection.findUniqueOrThrow({ where: { id: fresh.connectionId } })
        : null;
      if (
        prior &&
        (prior.version !== fresh.connectionVersion ||
          !["READY", "RECONNECT_REQUIRED", "DISCONNECTED"].includes(prior.status) ||
          prior.accountId !== result.accountId)
      )
        throw new ConnectorError(
          "stale_connection",
          "Connection changed or a different Google account was selected.",
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
            selectedScopes: fresh.selectedScopes,
            grantedScopes: grants,
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
          selectedScopes: fresh.selectedScopes,
          grantedScopes: grants,
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
  } catch {
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
/** Cancels an authorization attempt and revokes any retained Google grant before local cleanup. */
export async function cancelAuthorizationAttempt({
  actor,
  id,
  administrator = false,
}: {
  actor: ConnectorActor;
  id: string;
  administrator?: boolean;
}) {
  const a = await db.connectionAuthorization.findUniqueOrThrow({ where: { id } });
  if (!administrator) assertConnectionOwner({ ownerId: a.ownerId, actorId: actor.id });
  if (a.status === "COMPLETED")
    throw new ConnectorError("completed", "Disconnect the completed connection instead.", 409);
  if (a.status === "PROCESSING")
    throw new ConnectorError(
      "in_progress",
      "Provider exchange is in progress or was interrupted. Check status; expired interrupted exchanges require administrator review of the Google grant.",
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
      if (value.credentials) await revokeGoogleAuthorization(value.credentials.refreshToken);
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
/** Lists recent authorization attempts for the administrative connections view. */
export async function listAuthorizations() {
  return db.connectionAuthorization.findMany({
    select: {
      id: true,
      ownerId: true,
      name: true,
      status: true,
      expiresAt: true,
      connector: { select: { key: true } },
      owner: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
/**
 * Performs administrator-only terminal cleanup after explicit acknowledgement; this never claims
 * that provider revocation succeeded.
 */
export async function discardAuthorization({ actor, id }: { actor: ConnectorActor; id: string }) {
  return runConnectorTransaction(async (tx) => {
    const a = await tx.connectionAuthorization.findUniqueOrThrow({ where: { id } });
    if (a.expiresAt.getTime() + 30_000 > Date.now())
      throw new ConnectorError(
        "in_progress",
        "Wait until the authorization has expired before terminal cleanup.",
        409,
      );
    await tx.connectionAuthorization.delete({ where: { id } });
    if (a.payloadId) await tx.encryptedValue.delete({ where: { id: a.payloadId } });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: id,
      operation: "authorization.discarded_revocation_unconfirmed",
      outcome: "failed",
      details: { connectorId: a.connectorId },
    });
  });
}
/** Decrypts and validates the stored Google credentials for one connection lifecycle operation. */
async function readStoredCredentials({ tx, connection }: { tx: Tx; connection: Connection }) {
  if (!connection.credentialId)
    throw new ConnectorError("reconnect_required", "Reconnect this connection.", 409);
  return credentialsSchema.parse(
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
  actor: ConnectorActor;
  selector: string;
}) {
  const claim = await runConnectorTransaction(async (tx) => {
    const row = await findOwnedConnection({ tx, selector, actor });
    assertConnectorEnabled(row.connector);
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
    const credentials = await readStoredCredentials({ tx, connection: row });
    if (credentials.expiresAt > Date.now() + 60_000)
      return { row, credentials, refresh: false as const };
    const updated = await tx.connection.update({
      where: { id: row.id, version: row.version, status: "READY" },
      data: { status: "REFRESHING", refreshStartedAt: new Date(), version: { increment: 1 } },
    });
    return {
      row: { ...updated, connector: row.connector },
      credentials,
      refresh: true as const,
      client: readGoogleClient(row.connector),
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
    const credentials = await refreshGoogleCredentials({
      client: claim.client,
      previous: claim.credentials,
    });
    const refreshed = await runConnectorTransaction(async (tx) => {
      const row = await tx.connection.findUniqueOrThrow({
        where: { id: claim.row.id },
        include: { connector: true },
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
      const usable = !shouldReconnectAfterRefresh({
        config: row.connector,
        selected: row.selectedScopes,
        previous: row.grantedScopes,
        next: credentials.grantedScopes,
      });
      await tx.connection.update({
        where: { id: row.id, version: row.version },
        data: {
          status: pending ? "REVOCATION_PENDING" : usable ? "READY" : "RECONNECT_REQUIRED",
          grantedScopes: credentials.grantedScopes,
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
        include: { connector: true },
      });
    });
    return { row: refreshed, credentials, refresh: false as const };
  } catch (error) {
    await recordRefreshFailure({
      id: claim.row.id,
      version: claim.row.version,
      actor,
      authorizationLost: error instanceof GoogleTokenError && error.authorizationLost,
      retryable: error instanceof GoogleTokenError && error.retryable,
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
 * Disconnects locally before provider I/O; failed or interrupted revocation remains blocked with
 * encrypted credentials so an owner or administrator can retry explicitly.
 */
export async function disconnectConnection({
  actor,
  selector,
  administrator = false,
}: {
  actor: ConnectorActor;
  selector: string;
  administrator?: boolean;
}) {
  const row = await runConnectorTransaction(async (tx) => {
    const current = administrator
      ? await tx.connection.findUniqueOrThrow({ where: { id: selector } })
      : await findOwnedConnection({ tx, selector, actor });
    if (current.status === "DISCONNECTED") return current;
    const updated = await tx.connection.update({
      where: { id: current.id, version: current.version },
      data: {
        status: "REVOCATION_PENDING",
        revocationError: "Provider revocation unconfirmed; explicit retry may be required.",
        version: { increment: 1 },
      },
    });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: current.id,
      operation: "disconnect.blocked",
    });
    return updated;
  });
  if (row.status === "DISCONNECTED")
    return {
      status: "DISCONNECTED",
      revocationConfirmed: !row.revocationError,
      message: row.revocationError,
    };
  if (row.refreshStartedAt && row.refreshStartedAt.getTime() > Date.now() - 30_000)
    return {
      status: "REVOCATION_PENDING",
      message: "Refresh is in flight. Retry disconnect after it completes.",
    };
  try {
    const credentials = await readStoredCredentials({ tx: db, connection: row });
    await revokeGoogleAuthorization(credentials.refreshToken);
    await runConnectorTransaction(async (tx) => {
      await tx.connection.update({
        where: { id: row.id, version: row.version, status: "REVOCATION_PENDING" },
        data: {
          credentialId: null,
          status: "DISCONNECTED",
          revocationError: null,
          refreshStartedAt: null,
          version: { increment: 1 },
        },
      });
      if (row.credentialId) await tx.encryptedValue.delete({ where: { id: row.credentialId } });
      await writeConnectorAuditLog({
        tx,
        actor,
        event: "lifecycle",
        subjectId: row.id,
        operation: "disconnect.confirmed",
        details: { connectorId: row.connectorId, accountId: row.accountId },
      });
    });
    return { status: "DISCONNECTED", revocationConfirmed: true };
  } catch {
    await writeConnectorAuditLog({
      tx: db,
      actor,
      event: "lifecycle",
      subjectId: row.id,
      operation: "disconnect.unconfirmed",
      outcome: "failed",
    });
    return {
      status: "REVOCATION_PENDING",
      message: "Provider revocation unconfirmed. Retry disconnect explicitly.",
    };
  }
}
/**
 * Performs explicit administrator terminal cleanup while preserving that local disconnection is not
 * evidence of provider revocation.
 */
export async function discardConnection({
  actor,
  id,
  version,
}: {
  actor: ConnectorActor;
  id: string;
  version: number;
}) {
  return runConnectorTransaction(async (tx) => {
    const row = await tx.connection.findUniqueOrThrow({ where: { id, version } });
    if (
      row.status !== "REVOCATION_PENDING" ||
      (row.refreshStartedAt && row.refreshStartedAt.getTime() > Date.now() - 30_000)
    )
      throw new ConnectorError(
        "in_progress",
        "Block the connection and let any in-flight refresh finish before terminal cleanup.",
        409,
      );
    await tx.connection.update({
      where: { id, version },
      data: {
        status: "DISCONNECTED",
        credentialId: null,
        refreshStartedAt: null,
        version: { increment: 1 },
        revocationError:
          "Provider revocation unconfirmed. An administrator discarded retry credentials; revoke the grant in Google account settings.",
      },
    });
    if (row.credentialId) await tx.encryptedValue.delete({ where: { id: row.credentialId } });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: id,
      operation: "disconnect.discarded_revocation_unconfirmed",
      outcome: "failed",
      details: { connectorId: row.connectorId, accountId: row.accountId },
    });
  });
}
/** Deletes a fully disconnected connection and its terminal authorization history. */
export async function deleteConnection({
  actor,
  selector,
  administrator = false,
}: {
  actor: ConnectorActor;
  selector: string;
  administrator?: boolean;
}) {
  await runConnectorTransaction(async (tx) => {
    const row = administrator
      ? await tx.connection.findUniqueOrThrow({ where: { id: selector } })
      : await findOwnedConnection({ tx, selector, actor });
    if (row.status !== "DISCONNECTED" || row.credentialId)
      throw new ConnectorError(
        "revocation_required",
        "Confirm provider revocation or have an administrator acknowledge terminal cleanup before deletion.",
        409,
      );
    const attempts = await tx.connectionAuthorization.findMany({ where: { connectionId: row.id } });
    if (
      attempts.some(
        (a) =>
          a.payloadId ||
          ["SETUP", "AUTHORIZING", "PROCESSING", "NEEDS_REVOCATION"].includes(a.status),
      )
    )
      throw new ConnectorError("attempt_active", "Cancel outstanding authorizations first.", 409);
    await tx.connectionAuthorization.deleteMany({ where: { connectionId: row.id } });
    await tx.connection.delete({ where: { id: row.id, version: row.version } });
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: row.id,
      operation: "connection.deleted",
    });
  });
}
