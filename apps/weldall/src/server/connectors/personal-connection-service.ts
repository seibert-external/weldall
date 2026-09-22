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
  type OAuthCredentials,
} from "./types";

// Personal connections are owner-only and device-local. SharedConnection will have
// its own authorization, credential storage, and execution lifecycle.
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
  allowedTargetPrefixes: string[];
}

export interface PersonalConnectionDto {
  id: string;
  name: string;
  connectorId: string;
  connectorKey: string;
  connectorName: string;
  account: { id: string; displayName: string };
  deviceId: string;
  status: "ready" | "reconnect_required";
  enabledApis: string[];
  grantedScopes: string[];
  allowedTargetPrefixes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
  version: number;
}

export interface UserAuthorizationStartDto {
  authorizationId: string;
  connectionId: string;
  connectionName: string;
  mode: "connect" | "reconnect";
  authorizationUrl: string;
}

export interface UserDisconnectResult {
  id: string;
  name: string;
  providerRevocation: "confirmed" | "failed" | "not_requested";
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

const connectorConfigurationSelect = {
  id: true,
  key: true,
  name: true,
  type: true,
  enabled: true,
  enabledApis: true,
  oauthScopes: true,
  oauthClientId: true,
  encryptedOAuthClientSecret: true,
} as const;

const userConnectionInclude = {
  owner: { select: { email: true } },
  connector: { select: connectorConfigurationSelect },
} as const;

const userAuthorizationInclude = {
  owner: { select: { email: true } },
  connector: { select: connectorConfigurationSelect },
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

export async function listUserConnections(ownerId: string): Promise<PersonalConnectionDto[]> {
  await pruneExpiredAuthorizations();
  const rows = await db.personalConnection.findMany({
    where: { ownerId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: userConnectionInclude,
  });
  return rows.map(serializeUserConnection);
}

export async function getUserConnection(
  ownerId: string,
  selector: string,
): Promise<PersonalConnectionDto> {
  return serializeUserConnection(await loadUserConnection(ownerId, selector));
}

export async function startConnectionAuthorization(
  input: {
    connector: string;
    name: string;
    deviceId: string;
  },
  actor: ConnectorUserActor,
): Promise<UserAuthorizationStartDto> {
  await pruneExpiredAuthorizations();
  const connectionName = parseConnectionName(input.name);
  const deviceId = parseDeviceId(input.deviceId);
  const connector = await db.connector.findFirst({
    where: { enabled: true, OR: [{ id: input.connector }, { key: input.connector }] },
    select: connectorConfigurationSelect,
  });
  if (!connector) throw new ConnectorUserError("not_found", "Connector was not found.", 404);
  const existing = await db.personalConnection.findFirst({
    where: { ownerId: actor.id, name: connectionName },
    select: { id: true },
  });
  if (existing) {
    throw new ConnectorUserError(
      "conflict",
      `Connection ${JSON.stringify(connectionName)} already exists.`,
      409,
    );
  }
  try {
    return await createAuthorization(
      {
        connectionId: randomUUID(),
        connectionName,
        connectionVersion: null,
        connector,
        mode: "connect",
        ownerId: actor.id,
      },
      deviceId,
      actor,
    );
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      throw new ConnectorUserError(
        "conflict",
        `Connection ${JSON.stringify(connectionName)} is already being connected.`,
        409,
      );
    }
    throw error;
  }
}

export async function restartConnectionAuthorization(
  ownerId: string,
  selector: string,
  deviceId: string,
  actor: ConnectorUserActor,
): Promise<UserAuthorizationStartDto> {
  const connection = await loadUserConnection(ownerId, selector);
  if (!connection.connector.enabled) {
    throw new ConnectorUserError("disabled", "The connector is disabled.", 409);
  }
  return createAuthorization(
    {
      connectionId: connection.id,
      connectionName: connection.name,
      connectionVersion: connection.version,
      connector: connection.connector,
      mode: "reconnect",
      ownerId,
    },
    parseDeviceId(deviceId),
    actor,
  );
}

async function createAuthorization(
  input: {
    connectionId: string;
    connectionName: string;
    connectionVersion: number | null;
    connector: {
      id: string;
      key: string;
      name: string;
      type: string;
      enabled: boolean;
      enabledApis: string[];
      oauthScopes: string[];
      oauthClientId: string;
      encryptedOAuthClientSecret: string;
    };
    mode: "connect" | "reconnect";
    ownerId: string;
  },
  deviceId: string,
  actor: ConnectorUserActor,
): Promise<UserAuthorizationStartDto> {
  const state = randomValue();
  const nonce = randomValue();
  const codeVerifier = randomValue(64);
  const codeChallenge = hash(codeVerifier);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS);
  const implementation = connectorImplementation(input.connector.type);
  const authorization = await db.$transaction(async (tx) => {
    if (input.mode === "reconnect") {
      if (input.connectionVersion === null) throw new Error("Missing connection version");
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "PersonalConnection" WHERE "id" = ${input.connectionId} FOR UPDATE`,
      );
      const current = await tx.personalConnection.findFirst({
        where: {
          id: input.connectionId,
          connectorId: input.connector.id,
          ownerId: input.ownerId,
          version: input.connectionVersion,
        },
        select: { id: true },
      });
      if (!current) {
        throw new ConnectorUserError("conflict", "Connection changed. Reload and try again.", 409);
      }
      await tx.personalConnectionAuthorization.deleteMany({
        where: { connectionId: input.connectionId },
      });
    }
    const pending = await tx.personalConnectionAuthorization.create({
      data: {
        connectionId: input.connectionId,
        connectorId: input.connector.id,
        ownerId: input.ownerId,
        connectionName: input.connectionName,
        stateHash: hash(state),
        encryptedPayload: "pending",
        mode: input.mode,
        expiresAt,
      },
    });
    const created = await tx.personalConnectionAuthorization.update({
      where: { id: pending.id },
      data: {
        encryptedPayload: sealConnectorValue(
          "authorization",
          pending.id,
          JSON.stringify({
            nonce,
            codeVerifier,
            deviceId,
            connectionVersion: input.connectionVersion,
          }),
        ),
      },
    });
    await prismaAuditWriter.write(
      authorizationAudit(actor, "connection.authorization_started", input),
      tx,
    );
    return created;
  });
  try {
    const started = await implementation.startAuthorization({
      config: connectorConfig(input.connector),
      redirectUri,
      state,
      nonce,
      codeChallenge,
    });
    if (!started.url.startsWith("https://accounts.google.com/")) {
      throw new Error("Connector returned an unsafe authorization URL");
    }
    return {
      authorizationId: authorization.id,
      connectionId: input.connectionId,
      connectionName: input.connectionName,
      mode: input.mode,
      authorizationUrl: started.url,
    };
  } catch (error) {
    await db.personalConnectionAuthorization
      .delete({ where: { id: authorization.id } })
      .catch(() => undefined);
    throw error;
  }
}

export async function rejectAuthorizationCallback(
  state: string,
  request: { requestId: string; correlationId?: string | undefined },
): Promise<void> {
  if (!state || state.length > 1_000) return;
  const authorization = await db.personalConnectionAuthorization.findUnique({
    where: { stateHash: hash(state) },
    include: userAuthorizationInclude,
  });
  if (!authorization || authorization.callbackConsumedAt || authorization.expiresAt <= new Date()) {
    return;
  }
  const consumed = await db.personalConnectionAuthorization.updateMany({
    where: { id: authorization.id, callbackConsumedAt: null, expiresAt: { gt: new Date() } },
    data: { callbackConsumedAt: new Date() },
  });
  if (consumed.count !== 1) return;
  await failAuthorization(authorization, {
    id: authorization.ownerId,
    email: authorization.owner.email,
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
  const authorization = await db.personalConnectionAuthorization.findUnique({
    where: { stateHash: hash(input.state) },
    include: userAuthorizationInclude,
  });
  if (!authorization || authorization.callbackConsumedAt || authorization.expiresAt <= new Date()) {
    throw new ConnectorUserError("invalid_request", "Authorization state is invalid or expired.");
  }
  const consumed = await db.personalConnectionAuthorization.updateMany({
    where: { id: authorization.id, callbackConsumedAt: null, expiresAt: { gt: new Date() } },
    data: { callbackConsumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new ConnectorUserError("invalid_request", "Authorization state was already used.");
  }
  const actor: ConnectorUserActor = {
    id: authorization.ownerId,
    email: authorization.owner.email,
    ...request,
  };
  let result: AuthorizationResult | undefined;
  try {
    if (!authorization.connector.enabled) {
      throw new ConnectorUserError("disabled", "The connector is unavailable.", 409);
    }
    const payload = z
      .object({
        nonce: z.string().min(20),
        codeVerifier: z.string().min(43),
        deviceId: z.string().regex(deviceIdPattern),
        connectionVersion: z.number().int().positive().nullable(),
      })
      .strict()
      .parse(
        JSON.parse(
          unsealConnectorValue("authorization", authorization.id, authorization.encryptedPayload),
        ),
      );
    if (
      !["connect", "reconnect"].includes(authorization.mode) ||
      (authorization.mode === "connect" && payload.connectionVersion !== null) ||
      (authorization.mode === "reconnect" && payload.connectionVersion === null)
    ) {
      throw new ConnectorUserError("invalid_request", "Invalid authorization state.");
    }
    const completed = await connectorImplementation(
      authorization.connector.type,
    ).completeAuthorization({
      config: connectorConfig(authorization.connector),
      redirectUri,
      code: input.code,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
    });
    result = completed;
    await db.$transaction(async (tx) => {
      const current = await tx.personalConnectionAuthorization.findUniqueOrThrow({
        where: { id: authorization.id },
      });
      if (current.completedAt || current.encryptedCredentials) {
        throw new ConnectorUserError("conflict", "Authorization was already completed.", 409);
      }
      const connector = await tx.connector.findUnique({
        where: { id: authorization.connectorId },
        select: { enabled: true },
      });
      if (!connector?.enabled) {
        throw new ConnectorUserError("disabled", "The connector is unavailable.", 409);
      }
      if (authorization.mode === "connect") {
        await tx.personalConnection.create({
          data: {
            id: authorization.connectionId,
            connectorId: authorization.connectorId,
            ownerId: authorization.ownerId,
            name: authorization.connectionName,
            providerAccountId: completed.account.id,
            accountDisplayName: completed.account.displayName,
            grantedScopes: completed.credentials.grantedScopes,
            deviceId: payload.deviceId,
            status: "READY",
            connectedAt: new Date(),
          },
        });
      } else {
        if (payload.connectionVersion === null) {
          throw new ConnectorUserError("invalid_request", "Invalid authorization state.");
        }
        const activated = await tx.personalConnection.updateMany({
          where: {
            id: authorization.connectionId,
            connectorId: authorization.connectorId,
            ownerId: authorization.ownerId,
            version: payload.connectionVersion,
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
      }
      await tx.personalConnectionAuthorization.update({
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
      const connection = await tx.personalConnection.findUniqueOrThrow({
        where: { id: authorization.connectionId },
        include: userConnectionInclude,
      });
      await prismaAuditWriter.write(
        connectionAudit(
          actor,
          authorization.mode === "reconnect" ? "connection.reconnected" : "connection.connected",
          connection,
        ),
        tx,
      );
    });
    scheduleAuthorizationCleanup(authorization.id);
  } catch (error) {
    if (result?.credentials.refreshToken) {
      await connectorImplementation(authorization.connector.type)
        .revokeCredentials({
          config: connectorConfig(authorization.connector),
          token: result.credentials.refreshToken,
        })
        .catch(() => undefined);
    }
    await failAuthorization(authorization, actor).catch(() => undefined);
    if (isPrismaError(error, "P2002")) {
      throw new ConnectorUserError(
        "conflict",
        "That connection name or Google account is already connected.",
        409,
      );
    }
    throw error;
  }
  if (!result) throw new Error("Authorization result was lost");
  return {
    connectionName: authorization.connectionName,
    accountDisplayName: result.account.displayName,
  };
}

async function failAuthorization(
  authorization: {
    id: string;
    connectionId: string;
    connectionName: string;
    connectorId: string;
    ownerId: string;
    mode: string;
    connector: { id: string; key: string };
  },
  actor: ConnectorUserActor,
) {
  await db.$transaction(async (tx) => {
    await prismaAuditWriter.write(
      {
        ...authorizationAudit(actor, "connection.authorization_failed", authorization),
        outcome: "failed",
        reasonCode: "invalid_grant",
      },
      tx,
    );
    await tx.personalConnectionAuthorization.deleteMany({ where: { id: authorization.id } });
  });
}

export async function consumeAuthorizationCredentials(
  ownerId: string,
  authorizationId: string,
  deviceId: string,
): Promise<{ connection: PersonalConnectionDto; credentials: OAuthCredentials }> {
  await pruneExpiredAuthorizations();
  const authorization = await db.personalConnectionAuthorization.findFirst({
    where: { id: authorizationId, ownerId, expiresAt: { gt: new Date() } },
  });
  if (!authorization) {
    throw new ConnectorUserError(
      "authorization_required",
      "Authorization is no longer active. Retry the connection flow.",
      409,
    );
  }
  const payload = z
    .object({
      nonce: z.string().min(20),
      codeVerifier: z.string().min(43),
      deviceId: z.string().regex(deviceIdPattern),
      connectionVersion: z.number().int().positive().nullable(),
    })
    .strict()
    .parse(
      JSON.parse(
        unsealConnectorValue("authorization", authorization.id, authorization.encryptedPayload),
      ),
    );
  if (payload.deviceId !== parseDeviceId(deviceId)) {
    throw new ConnectorUserError(
      "authorization_required",
      "Connection credentials belong to another device.",
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
  if (!authorization.completedAt || !authorization.encryptedCredentials) {
    throw new ConnectorUserError("authorization_pending", "Authorization has not completed.", 202);
  }
  const connection = await db.personalConnection.findFirst({
    where: {
      id: authorization.connectionId,
      connectorId: authorization.connectorId,
      ownerId,
      status: "READY",
    },
    include: userConnectionInclude,
  });
  if (!connection?.connector.enabled) {
    await db.personalConnectionAuthorization.delete({ where: { id: authorization.id } });
    throw new ConnectorUserError(
      connection ? "disabled" : "authorization_required",
      "Connection credentials are no longer available. Retry authorization.",
      409,
    );
  }
  const claimed = await db.personalConnectionAuthorization.updateMany({
    where: {
      id: authorization.id,
      completedAt: { not: null },
      encryptedCredentials: { not: null },
      credentialsConsumedAt: null,
    },
    data: { credentialsConsumedAt: new Date(), encryptedCredentials: null },
  });
  if (claimed.count !== 1) {
    throw new ConnectorUserError(
      "credentials_consumed",
      "Authorization credentials were already retrieved.",
      410,
    );
  }
  const credentials = oauthCredentialsSchema.parse(
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
): Promise<PersonalConnectionDto> {
  const connection = await loadUserConnection(ownerId, selector);
  if (connection.version !== expectedVersion) {
    throw new ConnectorUserError("conflict", "Connection changed. Reload and try again.", 409);
  }
  try {
    return await db.$transaction(async (tx) => {
      const write = await tx.personalConnection.updateMany({
        where: { id: connection.id, ownerId, version: expectedVersion },
        data: { name: parseConnectionName(name), version: { increment: 1 } },
      });
      if (write.count !== 1) {
        throw new ConnectorUserError("conflict", "Connection changed. Reload and try again.", 409);
      }
      return serializeUserConnection(
        await tx.personalConnection.findUniqueOrThrow({
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
  deviceId: string,
  refreshToken: string,
  actor: ConnectorUserActor,
): Promise<OAuthCredentials> {
  const connection = await loadUsableConnection(ownerId, selector);
  if (connection.deviceId !== parseDeviceId(deviceId)) {
    throw new ConnectorUserError(
      "authorization_required",
      "Connection credentials belong to another device.",
      409,
    );
  }
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
        await tx.personalConnection.update({
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
    if (!connection.connector.enabled) {
      throw new ConnectorUserError("disabled", "Connector is disabled.", 403);
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
      const usable = await tx.personalConnection.updateMany({
        where: {
          id: connection.id,
          ownerId: actor.id,
          status: "READY",
          connector: { enabled: true },
        },
        data: { lastLeaseAt: new Date() },
      });
      if (usable.count !== 1) {
        throw new ConnectorUserError("not_found", "Connection is no longer available.", 404);
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
): Promise<UserDisconnectResult> {
  const parsedToken = token ? parseToken(token) : undefined;
  const connection = await loadUserConnection(ownerId, selector);
  const deleted = await db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "PersonalConnection" WHERE "id" = ${connection.id} FOR UPDATE`,
    );
    const current = await tx.personalConnection.findUnique({
      where: { id: connection.id },
      include: userConnectionInclude,
    });
    if (!current || current.ownerId !== ownerId) {
      throw new ConnectorUserError("not_found", "Connection was not found.", 404);
    }
    await tx.personalConnectionAuthorization.deleteMany({ where: { connectionId: current.id } });
    const removed = await tx.personalConnection.deleteMany({
      where: { id: current.id, ownerId },
    });
    if (removed.count !== 1) {
      throw new ConnectorUserError("not_found", "Connection was not found.", 404);
    }
    await prismaAuditWriter.write(
      connectionAudit(actor, "connection.disconnected", current, {
        revocationAttempted: Boolean(parsedToken),
      }),
      tx,
    );
    return current;
  });

  if (!parsedToken) {
    return { id: deleted.id, name: deleted.name, providerRevocation: "not_requested" };
  }
  const providerRevocation = await connectorImplementation(deleted.connector.type)
    .revokeCredentials({
      config: connectorConfig(deleted.connector),
      token: parsedToken,
    })
    .then(() => "confirmed" as const)
    .catch(() => "failed" as const);
  return { id: deleted.id, name: deleted.name, providerRevocation };
}

async function loadUserConnection(ownerId: string, selector: string) {
  await pruneExpiredAuthorizations();
  const row =
    (await db.personalConnection.findFirst({
      where: { ownerId, id: selector },
      include: userConnectionInclude,
    })) ??
    (await db.personalConnection.findFirst({
      where: { ownerId, name: selector },
      include: userConnectionInclude,
    }));
  if (!row) throw new ConnectorUserError("not_found", "Connection was not found.", 404);
  return row;
}

async function loadUsableConnection(ownerId: string, selector: string) {
  const row = await loadUserConnection(ownerId, selector);
  if (!row.connector.enabled) {
    throw new ConnectorUserError("disabled", "Connector is disabled.", 403);
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
    allowedTargetPrefixes: allowedTargetPrefixes(row.enabledApis),
  };
}

function serializeUserConnection(row: {
  id: string;
  name: string;
  connectorId: string;
  providerAccountId: string;
  accountDisplayName: string;
  deviceId: string;
  status: string;
  grantedScopes: string[];
  connectedAt: Date;
  lastLeaseAt: Date | null;
  version: number;
  connector: {
    key: string;
    name: string;
    enabledApis: string[];
  };
}): PersonalConnectionDto {
  return {
    id: row.id,
    name: row.name,
    connectorId: row.connectorId,
    connectorKey: row.connector.key,
    connectorName: row.connector.name,
    account: { id: row.providerAccountId, displayName: row.accountDisplayName },
    deviceId: row.deviceId,
    status: statusForApi(row.status),
    enabledApis: enabledApisForScopes(row.connector.enabledApis, row.grantedScopes),
    grantedScopes: row.grantedScopes,
    allowedTargetPrefixes: allowedTargetPrefixes(row.connector.enabledApis, row.grantedScopes),
    connectedAt: row.connectedAt.toISOString(),
    lastUsedAt: row.lastLeaseAt?.toISOString() ?? null,
    version: row.version,
  };
}

function connectionAudit(
  actor: ConnectorUserActor,
  eventType:
    | "connection.connected"
    | "connection.reconnected"
    | "connection.disconnected"
    | "connection_credential.refreshed"
    | "connection_credential.refresh_failed",
  row: Parameters<typeof connectionMetadata>[0],
  extra: { revocationAttempted?: boolean } = {},
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
    metadata: { ...connectionMetadata(row), ...extra },
  };
}

function authorizationAudit(
  actor: ConnectorUserActor,
  eventType: "connection.authorization_started" | "connection.authorization_failed",
  authorization: {
    connectionId: string;
    connectionName: string;
    ownerId: string;
    mode: string;
    connector: { id: string; key: string };
  },
) {
  if (authorization.mode !== "connect" && authorization.mode !== "reconnect") {
    throw new Error("Unsupported authorization mode");
  }
  return {
    eventType,
    actorType: "user" as const,
    actorId: actor.id,
    actorEmail: actor.email,
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    outcome: "success" as const,
    subjectType: "connection",
    subjectId: authorization.connectionId,
    metadata: {
      connectorId: authorization.connector.id,
      connectorKey: authorization.connector.key,
      connectionId: authorization.connectionId,
      connectionName: authorization.connectionName,
      ownerId: authorization.ownerId,
      authorizationMode: authorization.mode,
    },
  };
}

function connectionMetadata(row: {
  id: string;
  name: string;
  ownerId: string;
  providerAccountId: string;
  accountDisplayName: string;
  grantedScopes: string[];
  status: string;
  connector: { id: string; key: string };
}) {
  return {
    connectorId: row.connector.id,
    connectorKey: row.connector.key,
    connectionId: row.id,
    connectionName: row.name,
    ownerId: row.ownerId,
    status: statusForApi(row.status),
    providerAccountId: row.providerAccountId,
    accountDisplayName: row.accountDisplayName,
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

const oauthCredentialsSchema = z
  .object({
    accessToken: z.string().min(1).max(20_000),
    refreshToken: z.string().min(1).max(20_000),
    expiresAt: z.number().int().positive(),
    grantedScopes: z.array(z.string().min(1).max(500)).max(100),
    tokenType: z.literal("Bearer"),
  })
  .strict();

async function pruneExpiredAuthorizations(): Promise<void> {
  await db.personalConnectionAuthorization.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
}

function scheduleAuthorizationCleanup(id: string): void {
  const timer = setTimeout(() => {
    void db.personalConnectionAuthorization
      .deleteMany({ where: { id, expiresAt: { lte: new Date() } } })
      .catch(() => undefined);
  }, AUTHORIZATION_TTL_MS + 1_000);
  timer.unref();
}

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}
