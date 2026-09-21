import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, Prisma } from "@weldall/db";
import { z } from "zod";
import { prismaAuditWriter } from "../audit/service";
import { WELDALL_ISSUER } from "../oauth/constants";
import { signWeldallJwt } from "../oauth/jwt";
import { connectorConfig, statusForApi } from "./admin-service";
import { sealConnectorValue, unsealConnectorValue } from "./credentials";
import {
  allowedTargetPrefixes,
  connectorImplementation,
  enabledApisForScopes,
  targetAllowed,
} from "./registry";
import {
  ConnectorAuthorizationError,
  type AuthorizationResult,
  type LocalCredentials,
} from "./types";

const AUTHORIZATION_TTL_MS = 5 * 60_000;
const LEASE_TTL_SECONDS = 60;
const connectionNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const deviceIdPattern = /^[A-Za-z0-9_-]{20,128}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const randomValue = (bytes = 32) => randomBytes(bytes).toString("base64url");
const redirectUri = `${WELDALL_ISSUER}/api/connectors/google/callback`;

export interface ConnectorUserActor {
  id: string;
  email: string;
  requestId: string;
  correlationId?: string | undefined;
}

export interface UserConnectorDto {
  id: string;
  key: string;
  name: string;
  type: "google";
  enabledApis: string[];
  oauthScopes: string[];
  credentialModes: ["local"];
  allowedTargetPrefixes: string[];
}

export interface UserConnectionDto {
  id: string;
  name: string;
  connectorId: string;
  connectorKey: string;
  connectorName: string;
  account: { id: string; displayName: string } | null;
  credentialMode: "local";
  deviceId: string;
  status: "pending" | "ready" | "reconnect_required" | "disabled" | "disconnected";
  enabledApis: string[];
  grantedScopes: string[];
  allowedTargetPrefixes: string[];
  connectedAt: string | null;
  lastUsedAt: string | null;
  version: number;
}

export class ConnectorUserError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "invalid_request"
      | "authorization_pending"
      | "authorization_required"
      | "disabled"
      | "credentials_consumed",
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ConnectorUserError";
  }
}

const userConnectionInclude = {
  owner: { select: { email: true } },
  connector: {
    select: {
      id: true,
      key: true,
      name: true,
      type: true,
      enabled: true,
      enabledApis: true,
      oauthScopes: true,
      oauthClientId: true,
      encryptedOAuthClientSecret: true,
    },
  },
} as const;

export async function listAvailableConnectors(): Promise<UserConnectorDto[]> {
  const rows = await db.connector.findMany({
    where: { enabled: true },
    orderBy: [{ name: "asc" }, { key: "asc" }],
  });
  return rows.map(serializeUserConnector);
}

export async function getAvailableConnector(selector: string): Promise<UserConnectorDto> {
  const row = await db.connector.findFirst({
    where: { enabled: true, OR: [{ id: selector }, { key: selector }] },
  });
  if (!row) throw new ConnectorUserError("not_found", "Connector was not found.", 404);
  return serializeUserConnector(row);
}

export async function listUserConnections(ownerId: string): Promise<UserConnectionDto[]> {
  await pruneExpiredAuthorizations();
  const rows = await db.connectorConnection.findMany({
    where: { ownerId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: userConnectionInclude,
  });
  return rows.map(serializeUserConnection);
}

export async function getUserConnection(
  ownerId: string,
  selector: string,
): Promise<UserConnectionDto> {
  return serializeUserConnection(await loadUserConnection(ownerId, selector));
}

export async function startConnectionAuthorization(
  input: {
    connector: string;
    name: string;
    deviceId: string;
  },
  actor: ConnectorUserActor,
): Promise<{ connection: UserConnectionDto; authorizationUrl: string }> {
  await pruneExpiredAuthorizations();
  const name = parseConnectionName(input.name);
  const deviceId = parseDeviceId(input.deviceId);
  const connector = await db.connector.findFirst({
    where: { enabled: true, OR: [{ id: input.connector }, { key: input.connector }] },
  });
  if (!connector) throw new ConnectorUserError("not_found", "Connector was not found.", 404);
  let connection;
  try {
    connection = await db.connectorConnection.create({
      data: {
        connectorId: connector.id,
        ownerId: actor.id,
        name,
        deviceId,
        credentialMode: "local",
      },
      include: userConnectionInclude,
    });
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      throw new ConnectorUserError(
        "conflict",
        `Connection ${JSON.stringify(name)} already exists.`,
        409,
      );
    }
    throw error;
  }
  try {
    const authorizationUrl = await createAuthorization(
      connection,
      "connect",
      connection.deviceId,
      actor,
    );
    return { connection: serializeUserConnection(connection), authorizationUrl };
  } catch (error) {
    await db.connectorConnection.delete({ where: { id: connection.id } }).catch(() => undefined);
    throw error;
  }
}

export async function restartConnectionAuthorization(
  ownerId: string,
  selector: string,
  deviceId: string,
  actor: ConnectorUserActor,
): Promise<{ connection: UserConnectionDto; authorizationUrl: string }> {
  const connection = await loadUserConnection(ownerId, selector);
  if (!connection.connector.enabled || connection.status === "DISABLED") {
    throw new ConnectorUserError("disabled", "The connector or connection is disabled.", 409);
  }
  const parsedDeviceId = parseDeviceId(deviceId);
  return {
    connection: serializeUserConnection(connection),
    authorizationUrl: await createAuthorization(connection, "reconnect", parsedDeviceId, actor),
  };
}

async function createAuthorization(
  connection: Awaited<ReturnType<typeof loadUserConnection>>,
  mode: "connect" | "reconnect",
  deviceId: string,
  actor: ConnectorUserActor,
): Promise<string> {
  const state = randomValue();
  const nonce = randomValue();
  const codeVerifier = randomValue(64);
  const codeChallenge = hash(codeVerifier);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS);
  const implementation = connectorImplementation(connection.connector.type);
  const authorization = await db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ConnectorConnection" WHERE "id" = ${connection.id} FOR UPDATE`,
    );
    await tx.connectorAuthorization.deleteMany({ where: { connectionId: connection.id } });
    const pending = await tx.connectorAuthorization.create({
      data: {
        connectionId: connection.id,
        stateHash: hash(state),
        encryptedPayload: "pending",
        mode,
        expiresAt,
      },
    });
    const created = await tx.connectorAuthorization.update({
      where: { id: pending.id },
      data: {
        encryptedPayload: sealConnectorValue(
          "authorization",
          pending.id,
          JSON.stringify({
            nonce,
            codeVerifier,
            deviceId,
            connectionVersion: connection.version,
          }),
        ),
      },
    });
    await prismaAuditWriter.write(
      connectionAudit(actor, "connection.authorization_started", connection),
      tx,
    );
    return created;
  });
  const started = await implementation.startAuthorization({
    config: connectorConfig(connection.connector),
    redirectUri,
    state,
    nonce,
    codeChallenge,
  });
  if (!started.url.startsWith("https://accounts.google.com/")) {
    await db.connectorAuthorization
      .delete({ where: { id: authorization.id } })
      .catch(() => undefined);
    throw new Error("Connector returned an unsafe authorization URL");
  }
  return started.url;
}

export async function rejectAuthorizationCallback(
  state: string,
  request: { requestId: string; correlationId?: string | undefined },
): Promise<void> {
  if (!state || state.length > 1_000) return;
  const authorization = await db.connectorAuthorization.findUnique({
    where: { stateHash: hash(state) },
    include: { connection: { include: userConnectionInclude } },
  });
  if (!authorization || authorization.callbackConsumedAt || authorization.expiresAt <= new Date()) {
    return;
  }
  const consumed = await db.connectorAuthorization.updateMany({
    where: { id: authorization.id, callbackConsumedAt: null, expiresAt: { gt: new Date() } },
    data: { callbackConsumedAt: new Date() },
  });
  if (consumed.count !== 1) return;
  await failAuthorization(authorization, {
    id: authorization.connection.ownerId,
    email: authorization.connection.owner.email,
    ...request,
  });
}

export async function completeAuthorizationCallback(
  input: { state: string; code: string },
  request: { requestId: string; correlationId?: string | undefined },
): Promise<{ connectionName: string; accountDisplayName: string }> {
  if (!input.state || input.state.length > 1_000 || !input.code || input.code.length > 10_000) {
    throw new ConnectorUserError("invalid_request", "Invalid authorization callback.");
  }
  const authorization = await db.connectorAuthorization.findUnique({
    where: { stateHash: hash(input.state) },
    include: { connection: { include: userConnectionInclude } },
  });
  if (!authorization || authorization.callbackConsumedAt || authorization.expiresAt <= new Date()) {
    throw new ConnectorUserError("invalid_request", "Authorization state is invalid or expired.");
  }
  const consumed = await db.connectorAuthorization.updateMany({
    where: { id: authorization.id, callbackConsumedAt: null, expiresAt: { gt: new Date() } },
    data: { callbackConsumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new ConnectorUserError("invalid_request", "Authorization state was already used.");
  }
  const actor: ConnectorUserActor = {
    id: authorization.connection.ownerId,
    email: authorization.connection.owner.email,
    ...request,
  };
  let result: AuthorizationResult | undefined;
  try {
    if (
      !authorization.connection.connector.enabled ||
      authorization.connection.status === "DISABLED"
    ) {
      throw new ConnectorUserError("disabled", "The connector or connection is disabled.", 409);
    }
    const payload = z
      .object({
        nonce: z.string().min(20),
        codeVerifier: z.string().min(43),
        deviceId: z.string().regex(deviceIdPattern),
        connectionVersion: z.number().int().positive(),
      })
      .strict()
      .parse(
        JSON.parse(
          unsealConnectorValue("authorization", authorization.id, authorization.encryptedPayload),
        ),
      );
    const completed = await connectorImplementation(
      authorization.connection.connector.type,
    ).completeAuthorization({
      config: connectorConfig(authorization.connection.connector),
      redirectUri,
      code: input.code,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
    });
    result = completed;
    await db.$transaction(async (tx) => {
      const current = await tx.connectorAuthorization.findUniqueOrThrow({
        where: { id: authorization.id },
      });
      if (current.completedAt || current.encryptedCredentials) {
        throw new ConnectorUserError("conflict", "Authorization was already completed.", 409);
      }
      const activated = await tx.connectorConnection.updateMany({
        where: {
          id: authorization.connection.id,
          version: payload.connectionVersion,
          status: authorization.connection.status,
          connector: { enabled: true },
        },
        data: {
          providerAccountId: completed.account.id,
          accountDisplayName: completed.account.displayName,
          grantedScopes: completed.credentials.grantedScopes,
          deviceId: payload.deviceId,
          status: "READY",
          connectedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (activated.count !== 1) {
        throw new ConnectorUserError(
          "conflict",
          "Connection changed while authorization was in progress. Retry from the CLI.",
          409,
        );
      }
      await tx.connectorAuthorization.update({
        where: { id: authorization.id },
        data: {
          encryptedCredentials: sealConnectorValue(
            "handoff",
            authorization.id,
            JSON.stringify(completed.credentials),
          ),
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + AUTHORIZATION_TTL_MS),
        },
      });
      await prismaAuditWriter.write(
        connectionAudit(
          actor,
          authorization.mode === "reconnect" ? "connection.reconnected" : "connection.connected",
          {
            ...authorization.connection,
            providerAccountId: completed.account.id,
            grantedScopes: completed.credentials.grantedScopes,
            status: "READY",
          },
        ),
        tx,
      );
    });
    scheduleAuthorizationCleanup(authorization.id);
  } catch (error) {
    if (result?.credentials.refreshToken) {
      await connectorImplementation(authorization.connection.connector.type)
        .revokeCredentials({
          config: connectorConfig(authorization.connection.connector),
          token: result.credentials.refreshToken,
        })
        .catch(() => undefined);
    }
    await failAuthorization(authorization, actor).catch(() => undefined);
    if (isPrismaError(error, "P2002")) {
      throw new ConnectorUserError(
        "conflict",
        "That Google account is already connected through this connector.",
        409,
      );
    }
    throw error;
  }
  if (!result) throw new Error("Authorization result was lost");
  return {
    connectionName: authorization.connection.name,
    accountDisplayName: result.account.displayName,
  };
}

async function failAuthorization(
  authorization: {
    mode: string;
    connection: Awaited<ReturnType<typeof loadUserConnection>>;
  },
  actor: ConnectorUserActor,
) {
  await db.$transaction(async (tx) => {
    if (authorization.mode === "connect") {
      await tx.connectorConnection.updateMany({
        where: { id: authorization.connection.id, status: "PENDING" },
        data: { status: "RECONNECT_REQUIRED", version: { increment: 1 } },
      });
    }
    const current = await tx.connectorConnection.findUniqueOrThrow({
      where: { id: authorization.connection.id },
      include: userConnectionInclude,
    });
    await prismaAuditWriter.write(
      {
        ...connectionAudit(actor, "connection.authorization_failed", current),
        outcome: "failed",
        reasonCode: "invalid_grant",
      },
      tx,
    );
  });
}

export async function consumeAuthorizationCredentials(
  ownerId: string,
  selector: string,
  deviceId: string,
): Promise<{ connection: UserConnectionDto; credentials: LocalCredentials }> {
  const connection = await loadUserConnection(ownerId, selector);
  if (connection.deviceId !== parseDeviceId(deviceId)) {
    throw new ConnectorUserError(
      "authorization_required",
      "Connection credentials belong to another device.",
      409,
    );
  }
  const authorization = await db.connectorAuthorization.findFirst({
    where: { connectionId: connection.id, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!authorization) {
    if (connection.status === "PENDING") {
      throw new ConnectorUserError(
        "authorization_pending",
        "Authorization has not completed.",
        202,
      );
    }
    throw new ConnectorUserError(
      "authorization_required",
      "Authorization is no longer active. Retry the connection flow.",
      409,
    );
  }
  if (authorization.callbackConsumedAt && !authorization.completedAt) {
    throw new ConnectorUserError(
      "authorization_required",
      "Authorization was not completed. Retry the connection flow.",
      409,
    );
  }
  if (
    authorization.completedAt &&
    (!connection.connector.enabled || connection.status !== "READY")
  ) {
    await db.connectorAuthorization.delete({ where: { id: authorization.id } });
    throw new ConnectorUserError(
      connection.status === "DISABLED" || !connection.connector.enabled
        ? "disabled"
        : "authorization_required",
      "Connection credentials are no longer available. Retry authorization.",
      409,
    );
  }
  if (authorization.credentialsConsumedAt) {
    throw new ConnectorUserError(
      "credentials_consumed",
      "Authorization credentials were already retrieved.",
      410,
    );
  }
  const claimed = await db.connectorAuthorization.updateMany({
    where: { id: authorization.id, credentialsConsumedAt: null },
    data: { credentialsConsumedAt: new Date(), encryptedCredentials: null },
  });
  if (claimed.count !== 1) {
    throw new ConnectorUserError(
      "credentials_consumed",
      "Authorization credentials were already retrieved.",
      410,
    );
  }
  if (!authorization.encryptedCredentials) {
    throw new ConnectorUserError("authorization_pending", "Authorization has not completed.", 202);
  }
  const credentials = localCredentialsSchema.parse(
    JSON.parse(
      unsealConnectorValue("handoff", authorization.id, authorization.encryptedCredentials),
    ),
  );
  return { connection: serializeUserConnection(connection), credentials };
}

export async function renameUserConnection(
  ownerId: string,
  selector: string,
  name: string,
  expectedVersion: number,
): Promise<UserConnectionDto> {
  const connection = await loadUserConnection(ownerId, selector);
  if (connection.version !== expectedVersion) {
    throw new ConnectorUserError("conflict", "Connection changed. Reload and try again.", 409);
  }
  try {
    return await db.$transaction(async (tx) => {
      const write = await tx.connectorConnection.updateMany({
        where: { id: connection.id, ownerId, version: expectedVersion },
        data: { name: parseConnectionName(name), version: { increment: 1 } },
      });
      if (write.count !== 1) {
        throw new ConnectorUserError("conflict", "Connection changed. Reload and try again.", 409);
      }
      return serializeUserConnection(
        await tx.connectorConnection.findUniqueOrThrow({
          where: { id: connection.id },
          include: userConnectionInclude,
        }),
      );
    });
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      throw new ConnectorUserError(
        "conflict",
        `Connection ${JSON.stringify(name)} already exists.`,
        409,
      );
    }
    throw error;
  }
}

export async function refreshUserConnection(
  ownerId: string,
  selector: string,
  refreshToken: string,
  actor: ConnectorUserActor,
): Promise<LocalCredentials> {
  const connection = await loadUsableConnection(ownerId, selector);
  try {
    const credentials = await connectorImplementation(connection.connector.type).refreshCredentials(
      {
        config: connectorConfig(connection.connector),
        refreshToken: parseToken(refreshToken),
        grantedScopes: connection.grantedScopes,
      },
    );
    await prismaAuditWriter.write(
      connectionAudit(actor, "connection_credential.refreshed", connection),
    );
    return credentials;
  } catch (error) {
    const reconnectRequired =
      error instanceof ConnectorAuthorizationError && error.reconnectRequired;
    await db.$transaction(async (tx) => {
      if (reconnectRequired) {
        await tx.connectorConnection.update({
          where: { id: connection.id },
          data: { status: "RECONNECT_REQUIRED", version: { increment: 1 } },
        });
      }
      await prismaAuditWriter.write(
        {
          ...connectionAudit(actor, "connection_credential.refresh_failed", {
            ...connection,
            status: reconnectRequired ? "RECONNECT_REQUIRED" : connection.status,
          }),
          outcome: "failed",
          reasonCode: reconnectRequired ? "invalid_grant" : "internal_error",
        },
        tx,
      );
    });
    throw new ConnectorUserError(
      reconnectRequired ? "authorization_required" : "conflict",
      reconnectRequired
        ? "Connection requires authorization."
        : "Google credentials could not be refreshed.",
      reconnectRequired ? 409 : 502,
    );
  }
}

export async function issueConnectionLease(
  ownerId: string,
  selector: string,
  input: { url: string; method: string },
  actor: ConnectorUserActor,
) {
  const connection = await loadUserConnection(ownerId, selector);
  const method = input.method.toUpperCase();
  const auditMethod = /^[A-Z]+$/.test(method) ? method : "INVALID";
  const target = targetAllowed(
    input.url,
    connection.connector.enabledApis,
    connection.grantedScopes,
  );
  const auditTarget = safeAuditTarget(input.url);
  if (
    connection.status !== "READY" ||
    !connection.connector.enabled ||
    !target ||
    !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)
  ) {
    if (auditTarget) {
      await prismaAuditWriter.write({
        ...leaseAudit(actor, connection, auditMethod, auditTarget),
        eventType: "connection_lease.denied",
        outcome: "denied",
        reasonCode:
          connection.status !== "READY" || !connection.connector.enabled
            ? "invalid_grant"
            : "invalid_resource",
      });
    }
    if (connection.status === "DISABLED" || !connection.connector.enabled) {
      throw new ConnectorUserError("disabled", "Connection is disabled.", 403);
    }
    if (connection.status !== "READY") {
      throw new ConnectorUserError(
        "authorization_required",
        "Connection requires authorization.",
        409,
      );
    }
    throw new ConnectorUserError("invalid_request", "Target is not allowed for this connection.");
  }
  try {
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = now + LEASE_TTL_SECONDS;
    const lease = await signWeldallJwt(
      {
        iss: WELDALL_ISSUER,
        aud: "weldall:connection-lease",
        sub: actor.id,
        jti: randomUUID(),
        iat: now,
        exp: expiresAt,
        connection_id: connection.id,
        device_id: connection.deviceId,
        method,
        target: `${target.origin}${target.pathname}`,
      },
      "weldall-connection-lease+jwt",
    );
    await db.$transaction(async (tx) => {
      const usable = await tx.connectorConnection.updateMany({
        where: {
          id: connection.id,
          ownerId: actor.id,
          status: "READY",
          connector: { enabled: true },
        },
        data: { lastLeaseAt: new Date() },
      });
      if (usable.count !== 1) {
        throw new ConnectorUserError("disabled", "Connection is no longer available.", 403);
      }
      await prismaAuditWriter.write(
        {
          ...leaseAudit(actor, connection, method, target),
          eventType: "connection_lease.issued",
        },
        tx,
      );
    });
    return {
      lease,
      expiresAt,
      connectionId: connection.id,
      allowedTargetPrefixes: allowedTargetPrefixes(
        connection.connector.enabledApis,
        connection.grantedScopes,
      ),
    };
  } catch (error) {
    await prismaAuditWriter
      .write({
        ...leaseAudit(actor, connection, method, target),
        eventType: "connection_lease.failed",
        outcome: "failed",
        reasonCode: "internal_error",
      })
      .catch(() => undefined);
    throw error;
  }
}

export async function disconnectUserConnection(
  ownerId: string,
  selector: string,
  token: string | undefined,
  actor: ConnectorUserActor,
): Promise<UserConnectionDto> {
  const connection = await loadUserConnection(ownerId, selector);
  if (connection.status === "DISCONNECTED") return serializeUserConnection(connection);
  const revocationAttempted = Boolean(token);
  let revocationConfirmed = false;
  if (token) {
    revocationConfirmed = await connectorImplementation(connection.connector.type)
      .revokeCredentials({
        config: connectorConfig(connection.connector),
        token: parseToken(token),
      })
      .then(() => true)
      .catch(() => false);
  }
  return db.$transaction(async (tx) => {
    await tx.connectorAuthorization.deleteMany({ where: { connectionId: connection.id } });
    const row = await tx.connectorConnection.update({
      where: { id: connection.id },
      data: { status: "DISCONNECTED", version: { increment: 1 } },
      include: userConnectionInclude,
    });
    await prismaAuditWriter.write(
      {
        ...connectionAudit(actor, "connection.disconnected", row),
        metadata: {
          ...connectionMetadata(row),
          revocationAttempted,
          revocationConfirmed,
        },
      },
      tx,
    );
    return serializeUserConnection(row);
  });
}

async function loadUserConnection(ownerId: string, selector: string) {
  await pruneExpiredAuthorizations();
  const row = await db.connectorConnection.findFirst({
    where: { ownerId, OR: [{ id: selector }, { name: selector }] },
    include: userConnectionInclude,
  });
  if (!row) throw new ConnectorUserError("not_found", "Connection was not found.", 404);
  return row;
}

async function loadUsableConnection(ownerId: string, selector: string) {
  const row = await loadUserConnection(ownerId, selector);
  if (!row.connector.enabled || row.status === "DISABLED") {
    throw new ConnectorUserError("disabled", "Connection is disabled.", 403);
  }
  if (row.status !== "READY") {
    throw new ConnectorUserError(
      "authorization_required",
      "Connection requires authorization.",
      409,
    );
  }
  return row;
}

function serializeUserConnector(row: {
  id: string;
  key: string;
  name: string;
  type: string;
  enabledApis: string[];
  oauthScopes: string[];
}): UserConnectorDto {
  if (row.type !== "google") throw new Error("Unsupported connector type");
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    type: row.type,
    enabledApis: row.enabledApis,
    oauthScopes: row.oauthScopes,
    credentialModes: ["local"],
    allowedTargetPrefixes: allowedTargetPrefixes(row.enabledApis),
  };
}

function serializeUserConnection(row: {
  id: string;
  name: string;
  connectorId: string;
  providerAccountId: string | null;
  accountDisplayName: string | null;
  credentialMode: string;
  deviceId: string;
  status: string;
  grantedScopes: string[];
  connectedAt: Date | null;
  lastLeaseAt: Date | null;
  version: number;
  connector: {
    key: string;
    name: string;
    enabledApis: string[];
  };
}): UserConnectionDto {
  if (row.credentialMode !== "local") throw new Error("Unsupported credential mode");
  return {
    id: row.id,
    name: row.name,
    connectorId: row.connectorId,
    connectorKey: row.connector.key,
    connectorName: row.connector.name,
    account:
      row.providerAccountId && row.accountDisplayName
        ? { id: row.providerAccountId, displayName: row.accountDisplayName }
        : null,
    credentialMode: "local",
    deviceId: row.deviceId,
    status: statusForApi(row.status),
    enabledApis: enabledApisForScopes(row.connector.enabledApis, row.grantedScopes),
    grantedScopes: row.grantedScopes,
    allowedTargetPrefixes: allowedTargetPrefixes(row.connector.enabledApis, row.grantedScopes),
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastUsedAt: row.lastLeaseAt?.toISOString() ?? null,
    version: row.version,
  };
}

function connectionAudit(
  actor: ConnectorUserActor,
  eventType:
    | "connection.authorization_started"
    | "connection.connected"
    | "connection.authorization_failed"
    | "connection.reconnected"
    | "connection.disconnected"
    | "connection_credential.refreshed"
    | "connection_credential.refresh_failed",
  row: Parameters<typeof connectionMetadata>[0],
) {
  return {
    eventType,
    actorType: "user" as const,
    actorId: actor.id,
    actorEmail: actor.email,
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    outcome: "success" as const,
    subjectType: "connection",
    subjectId: row.id,
    metadata: connectionMetadata(row),
  };
}

function connectionMetadata(row: {
  id: string;
  ownerId: string;
  providerAccountId: string | null;
  grantedScopes: string[];
  credentialMode: string;
  status: string;
  connector: { id: string; key: string };
}) {
  return {
    connectorId: row.connector.id,
    connectorKey: row.connector.key,
    connectionId: row.id,
    ownerId: row.ownerId,
    credentialMode: row.credentialMode,
    status: statusForApi(row.status),
    ...(row.providerAccountId ? { providerAccountId: row.providerAccountId } : {}),
    grantedScopes: row.grantedScopes,
  };
}

function leaseAudit(
  actor: ConnectorUserActor,
  row: { id: string; ownerId: string; connector: { id: string } },
  method: string,
  target: URL,
) {
  return {
    eventType: "connection_lease.issued" as const,
    actorType: "user" as const,
    actorId: actor.id,
    actorEmail: actor.email,
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    outcome: "success" as const,
    subjectType: "connection",
    subjectId: row.id,
    metadata: {
      connectorId: row.connector.id,
      connectionId: row.id,
      ownerId: row.ownerId,
      method,
      host: target.hostname,
      path: target.pathname,
    },
  };
}

function parseConnectionName(raw: string): string {
  const name = raw.trim();
  if (!connectionNamePattern.test(name) || name.length > 120) {
    throw new ConnectorUserError(
      "invalid_request",
      "Connection name must use letters, numbers, dots, dashes, or underscores.",
    );
  }
  return name;
}

function parseDeviceId(value: string): string {
  if (!deviceIdPattern.test(value)) {
    throw new ConnectorUserError("invalid_request", "Invalid device identifier.");
  }
  return value;
}

function parseToken(value: string): string {
  if (!value || value.length > 20_000 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConnectorUserError("invalid_request", "Invalid credential.");
  }
  return value;
}

function safeAuditTarget(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const localCredentialsSchema = z
  .object({
    accessToken: z.string().min(1).max(20_000),
    refreshToken: z.string().min(1).max(20_000),
    expiresAt: z.number().int().positive(),
    grantedScopes: z.array(z.string().min(1).max(500)).max(100),
    tokenType: z.literal("Bearer"),
  })
  .strict();

async function pruneExpiredAuthorizations(): Promise<void> {
  await db.connectorAuthorization.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}

function scheduleAuthorizationCleanup(id: string): void {
  const timer = setTimeout(() => {
    void db.connectorAuthorization
      .deleteMany({ where: { id, expiresAt: { lte: new Date() } } })
      .catch(() => undefined);
  }, AUTHORIZATION_TTL_MS + 1_000);
  timer.unref();
}

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}
