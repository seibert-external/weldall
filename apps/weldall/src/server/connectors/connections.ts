import { createHash, randomBytes } from "node:crypto";
import { db, type Connector, type Connection, type Prisma } from "@weldall/db";
import { z } from "zod";
import { WELDALL_ISSUER } from "../oauth/constants";
import { ConnectorError, connectionName, type ConnectorActor } from "./contracts";
import { transaction } from "./configuration";
import {
  availableScopes,
  effectiveCapabilities,
  normalizeGrants,
  refreshNeedsReconnect,
  requiredScopes,
  validateSelection,
} from "./scopes";
import { readSecret, saveSecret } from "./encryption";
import {
  authorizationUrl,
  completeGoogle,
  credentialsSchema,
  refreshGoogle,
  revokeGoogle,
  GoogleTokenError,
} from "./google";
import { connectorAudit } from "./audit";

type Tx = Prisma.TransactionClient;
const callback = `${WELDALL_ISSUER}/api/connectors/google/callback`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const random = () => randomBytes(32).toString("base64url");
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
/** A selector is not authority. Administrators may inspect/disconnect, never execute as another owner.
 * Future: connection IaC and scope/path/method-restricted connectionLease sharing may extend this check. */
export function assertOwner(ownerId: string, actorId: string) {
  if (ownerId !== actorId) throw new ConnectorError("not_found", "Connection not found.", 404);
}
export function connectionMetadata(
  row: Prisma.ConnectionGetPayload<{ select: typeof metadataSelect }>,
  connector: Connector,
) {
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
        ? effectiveCapabilities(connector, row.selectedScopes, row.grantedScopes)
        : [],
    connectorKey: connector.key,
    connectorEnabled: connector.enabled,
  };
}
export async function ownedConnection(tx: Tx, selector: string, actor: ConnectorActor) {
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
  assertOwner(row.ownerId, actor.id);
  return row;
}
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
    ...connectionMetadata(row, connector),
    owner,
  }));
}
export async function listConnectors() {
  return (await db.connector.findMany({ where: { enabled: true }, orderBy: { key: "asc" } })).map(
    (c) => ({
      key: c.key,
      name: c.name,
      type: c.type,
      scopes: availableScopes(c),
      defaultScopes: c.defaultScopes,
      requestPrefix: `${WELDALL_ISSUER}/connectors/${c.key}/`,
    }),
  );
}
async function client(tx: Tx, connector: Connector) {
  if (!connector.secretId)
    throw new ConnectorError("unavailable", "Connector is not configured.", 503);
  return {
    clientId: connector.clientId,
    clientSecret: await readSecret(
      tx,
      connector.secretId,
      `connector:${connector.id}:client-secret`,
    ),
  };
}
function assertEnabled(connector: Connector) {
  if (!connector.enabled) throw new ConnectorError("disabled", "Connector is disabled.", 409);
}
async function clearPayload(tx: Tx, id: string, payloadId: string | null) {
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
    await transaction(async (tx) => {
      const removed = await tx.connectionAuthorization.deleteMany({
        where: { id: a.id, status: a.status },
      });
      if (removed.count && a.payloadId)
        await tx.encryptedValue.delete({ where: { id: a.payloadId } });
    });
}
export async function startConnection(
  actor: ConnectorActor,
  input: { connector: string; name: string; reconnect?: string | undefined },
) {
  await cleanupAttempts();
  return transaction(async (tx) => {
    const connector = await tx.connector.findUnique({ where: { key: input.connector } });
    if (!connector) throw new ConnectorError("not_found", "Connector not found.", 404);
    assertEnabled(connector);
    const prior = input.reconnect ? await ownedConnection(tx, input.reconnect, actor) : null;
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
    await connectorAudit(tx, actor, "lifecycle", attempt.id, "authorization.started", "success", {
      connectorId: connector.id,
    });
    // Future external resources may advertise a scope catalog or their own short-lived setup URL; no credentials need transfer.
    return {
      id: attempt.id,
      setupUrl: `${WELDALL_ISSUER}/connections/setup/${attempt.id}`,
      expiresAt: attempt.expiresAt,
    };
  });
}
export async function getAttempt(actor: ConnectorActor, id: string) {
  const a = await db.connectionAuthorization.findUnique({
    where: { id },
    include: { connector: true, connection: { select: metadataSelect } },
  });
  if (!a) throw new ConnectorError("not_found", "Authorization attempt not found.", 404);
  assertOwner(a.ownerId, actor.id);
  const status =
    a.expiresAt <= new Date() && ["SETUP", "AUTHORIZING"].includes(a.status) ? "EXPIRED" : a.status;
  return {
    id: a.id,
    status,
    connector: { key: a.connector.key, name: a.connector.name, version: a.connectorVersion },
    scopes: availableScopes(a.connector),
    selectedScopes: a.selectedScopes,
    capabilities: effectiveCapabilities(a.connector, a.selectedScopes, a.selectedScopes),
    expiresAt: a.expiresAt,
    connection:
      a.status === "COMPLETED" && a.connection
        ? connectionMetadata(a.connection, a.connector)
        : null,
  };
}
export async function submitSelection(actor: ConnectorActor, id: string, selected: string[]) {
  return transaction(async (tx) => {
    const a = await tx.connectionAuthorization.findUniqueOrThrow({
      where: { id },
      include: { connector: true },
    });
    assertOwner(a.ownerId, actor.id);
    assertEnabled(a.connector);
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
    const scopes = validateSelection(a.connector, selected);
    const state = random(),
      verifier = random(),
      nonce = random();
    const payload = await saveSecret(
      tx,
      a.connector.encryptionKeyId,
      `attempt:${id}:oauth`,
      JSON.stringify({ verifier, nonce }),
    );
    await tx.connectionAuthorization.update({
      where: { id, status: "SETUP" },
      data: {
        selectedScopes: scopes,
        stateHash: hash(state),
        payloadId: payload.id,
        status: "AUTHORIZING",
      },
    });
    return {
      url: authorizationUrl({
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
/** Exchange is outside the transaction. Claim single-use state first, then revalidate policy and versions at commit. */
export async function completeConnection(state: string, code: string | null, cancelled: boolean) {
  const claimed = await transaction(async (tx) => {
    const a = await tx.connectionAuthorization.findUnique({
      where: { stateHash: hash(state) },
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
    assertEnabled(a.connector);
    await tx.connectionAuthorization.update({
      where: { id: a.id, status: "AUTHORIZING" },
      data: { status: cancelled ? "CANCELLED" : "PROCESSING", stateHash: null },
    });
    const payload = attemptPayload.parse(
      JSON.parse(await readSecret(tx, a.payloadId, `attempt:${a.id}:oauth`)),
    );
    if (cancelled) {
      await clearPayload(tx, a.id, a.payloadId);
      return null;
    }
    return { a, payload, client: await client(tx, a.connector) };
  });
  if (!claimed) return "cancelled" as const;
  const { a, payload } = claimed;
  const actor = { id: a.ownerId, requestId: a.id };
  let result: Awaited<ReturnType<typeof completeGoogle>>;
  try {
    if (!code) throw new ConnectorError("invalid_callback", "Authorization code missing.");
    result = await completeGoogle(claimed.client, {
      code,
      redirectUri: callback,
      nonce: payload.nonce,
      verifier: payload.verifier,
    });
  } catch {
    await transaction(async (tx) => {
      await tx.connectionAuthorization.update({ where: { id: a.id }, data: { status: "FAILED" } });
      await clearPayload(tx, a.id, a.payloadId);
      await connectorAudit(tx, actor, "lifecycle", a.id, "authorization.failed", "failed");
    });
    return "failed" as const;
  }
  // Preserve newly received credentials before policy validation, so a rejected callback has an explicit revocation path.
  await transaction(async (tx) => {
    // A key reassignment/re-encryption may have happened during provider I/O.
    // Retained cleanup material uses the current selection, not an in-memory old key ID.
    const current = await tx.connector.findUniqueOrThrow({ where: { id: a.connectorId } });
    await saveSecret(
      tx,
      current.encryptionKeyId,
      `attempt:${a.id}:oauth`,
      JSON.stringify({ ...payload, credentials: result.credentials }),
      a.payloadId,
    );
    await tx.connectionAuthorization.update({
      where: { id: a.id, status: "PROCESSING" },
      data: { status: "NEEDS_REVOCATION" },
    });
  });
  try {
    await transaction(async (tx) => {
      const fresh = await tx.connectionAuthorization.findUniqueOrThrow({
        where: { id: a.id },
        include: { connector: true },
      });
      assertEnabled(fresh.connector);
      if (
        fresh.status !== "NEEDS_REVOCATION" ||
        fresh.connectorVersion !== fresh.connector.version ||
        fresh.expiresAt <= new Date()
      )
        throw new ConnectorError("stale_attempt", "Authorization expired or policy changed.", 409);
      validateSelection(fresh.connector, fresh.selectedScopes);
      const grants = normalizeGrants(result.credentials.grantedScopes);
      if (
        requiredScopes.some((s) => !grants.includes(s)) ||
        !effectiveCapabilities(fresh.connector, fresh.selectedScopes, grants).length
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
      const secret = await saveSecret(
        tx,
        fresh.connector.encryptionKeyId,
        `connection:${row.id}:credentials`,
        JSON.stringify(result.credentials),
        row.credentialId,
      );
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
      await clearPayload(tx, a.id, a.payloadId);
      await connectorAudit(
        tx,
        actor,
        "lifecycle",
        row.id,
        prior ? "connection.reconnected" : "connection.connected",
        "success",
        { connectorId: row.connectorId, accountId: row.accountId },
      );
    });
    return "success" as const;
  } catch {
    await connectorAudit(db, actor, "lifecycle", a.id, "authorization.cleanup_required", "failed");
    return "failed" as const;
  }
}
export async function cancelAttempt(actor: ConnectorActor, id: string, administrator = false) {
  const a = await db.connectionAuthorization.findUniqueOrThrow({ where: { id } });
  if (!administrator) assertOwner(a.ownerId, actor.id);
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
      JSON.parse(await readSecret(db, a.payloadId, `attempt:${id}:oauth`)),
    );
    try {
      if (value.credentials) await revokeGoogle(value.credentials.refreshToken);
    } catch (error) {
      await connectorAudit(
        db,
        actor,
        "lifecycle",
        id,
        "authorization.revocation_unconfirmed",
        "failed",
      );
      throw error;
    }
  }
  await transaction(async (tx) => {
    const removed = await tx.connectionAuthorization.updateMany({
      where: { id, status: expectedStatus },
      data: { status: "CANCELLED", stateHash: null },
    });
    if (!removed.count) throw new ConnectorError("conflict", "Authorization changed; reload.", 409);
    await clearPayload(tx, id, a.payloadId);
    await connectorAudit(tx, actor, "lifecycle", id, "authorization.cancelled");
  });
}
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
/** Administrator-only terminal cleanup after explicit acknowledgement; this does NOT claim provider revocation. */
export async function discardAuthorization(actor: ConnectorActor, id: string) {
  return transaction(async (tx) => {
    const a = await tx.connectionAuthorization.findUniqueOrThrow({ where: { id } });
    if (a.expiresAt.getTime() + 30_000 > Date.now())
      throw new ConnectorError(
        "in_progress",
        "Wait until the authorization has expired before terminal cleanup.",
        409,
      );
    await tx.connectionAuthorization.delete({ where: { id } });
    if (a.payloadId) await tx.encryptedValue.delete({ where: { id: a.payloadId } });
    await connectorAudit(
      tx,
      actor,
      "lifecycle",
      id,
      "authorization.discarded_revocation_unconfirmed",
      "failed",
      { connectorId: a.connectorId },
    );
  });
}
async function storedCredentials(tx: Tx, connection: Connection) {
  if (!connection.credentialId)
    throw new ConnectorError("reconnect_required", "Reconnect this connection.", 409);
  return credentialsSchema.parse(
    JSON.parse(
      await readSecret(tx, connection.credentialId, `connection:${connection.id}:credentials`),
    ),
  );
}
/** Persisted compare-and-set is the cross-process refresh claim. Unknown/ambiguous outcomes require reconnect, not blind retries. */
export async function accessCredentials(actor: ConnectorActor, selector: string) {
  const claim = await transaction(async (tx) => {
    const row = await ownedConnection(tx, selector, actor);
    assertEnabled(row.connector);
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
    const credentials = await storedCredentials(tx, row);
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
      client: await client(tx, row.connector),
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
    const credentials = await refreshGoogle(claim.client, claim.credentials);
    const refreshed = await transaction(async (tx) => {
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
      await saveSecret(
        tx,
        row.connector.encryptionKeyId,
        `connection:${row.id}:credentials`,
        JSON.stringify(credentials),
        row.credentialId,
      );
      const usable = !refreshNeedsReconnect(
        row.connector,
        row.selectedScopes,
        row.grantedScopes,
        credentials.grantedScopes,
      );
      await tx.connection.update({
        where: { id: row.id, version: row.version },
        data: {
          status: pending ? "REVOCATION_PENDING" : usable ? "READY" : "RECONNECT_REQUIRED",
          grantedScopes: credentials.grantedScopes,
          refreshStartedAt: null,
          version: { increment: 1 },
        },
      });
      await connectorAudit(tx, actor, "lifecycle", row.id, "connection.refreshed");
      return tx.connection.findUniqueOrThrow({
        where: { id: row.id },
        include: { connector: true },
      });
    });
    return { row: refreshed, credentials, refresh: false as const };
  } catch (error) {
    await txRefreshFailure(
      claim.row.id,
      claim.row.version,
      actor,
      error instanceof GoogleTokenError && error.authorizationLost,
      error instanceof GoogleTokenError && error.retryable,
    );
    throw new ConnectorError(
      "refresh_failed",
      "Refresh failed. Check connection status; reconnect if required.",
      502,
    );
  }
}
async function txRefreshFailure(
  id: string,
  version: number,
  actor: ConnectorActor,
  lost: boolean,
  retryable: boolean,
) {
  await transaction(async (tx) => {
    await tx.connection.updateMany({
      where: { id, version, status: "REFRESHING" },
      data: {
        status: retryable ? "READY" : "RECONNECT_REQUIRED",
        refreshStartedAt: null,
        version: { increment: 1 },
      },
    });
    await connectorAudit(
      tx,
      actor,
      "lifecycle",
      id,
      lost
        ? "refresh.authorization_lost"
        : retryable
          ? "refresh.transient_failure"
          : "refresh.outcome_uncertain",
      "failed",
    );
  });
}
/** Unavailability commits BEFORE provider I/O. Failed/interrupted revocation remains blocked with encrypted credentials for manual retry. */
export async function disconnect(actor: ConnectorActor, selector: string, administrator = false) {
  const row = await transaction(async (tx) => {
    const current = administrator
      ? await tx.connection.findUniqueOrThrow({ where: { id: selector } })
      : await ownedConnection(tx, selector, actor);
    if (current.status === "DISCONNECTED") return current;
    const updated = await tx.connection.update({
      where: { id: current.id, version: current.version },
      data: {
        status: "REVOCATION_PENDING",
        revocationError: "Provider revocation unconfirmed; explicit retry may be required.",
        version: { increment: 1 },
      },
    });
    await connectorAudit(tx, actor, "lifecycle", current.id, "disconnect.blocked");
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
    const credentials = await storedCredentials(db, row);
    await revokeGoogle(credentials.refreshToken);
    await transaction(async (tx) => {
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
      await connectorAudit(tx, actor, "lifecycle", row.id, "disconnect.confirmed", "success", {
        connectorId: row.connectorId,
        accountId: row.accountId,
      });
    });
    return { status: "DISCONNECTED", revocationConfirmed: true };
  } catch {
    await connectorAudit(db, actor, "lifecycle", row.id, "disconnect.unconfirmed", "failed");
    return {
      status: "REVOCATION_PENDING",
      message: "Provider revocation unconfirmed. Retry disconnect explicitly.",
    };
  }
}
/** Explicit administrator terminal cleanup. Local disconnection is not a claim of provider revocation. */
export async function discardConnection(actor: ConnectorActor, id: string, version: number) {
  return transaction(async (tx) => {
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
    await connectorAudit(
      tx,
      actor,
      "lifecycle",
      id,
      "disconnect.discarded_revocation_unconfirmed",
      "failed",
      { connectorId: row.connectorId, accountId: row.accountId },
    );
  });
}
export async function deleteConnection(
  actor: ConnectorActor,
  selector: string,
  administrator = false,
) {
  await transaction(async (tx) => {
    const row = administrator
      ? await tx.connection.findUniqueOrThrow({ where: { id: selector } })
      : await ownedConnection(tx, selector, actor);
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
    await connectorAudit(tx, actor, "lifecycle", row.id, "connection.deleted");
  });
}
