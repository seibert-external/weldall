import { db, Prisma } from "@weldall/db";
import { AdminDomainError, type AdminActor } from "../admin/service";
import { prismaAuditWriter } from "../audit/service";
import { lockConfigurationChanges } from "../domain/configuration";
import { sealConnectorValue, unsealConnectorValue } from "./credentials";
import { testGoogleConfiguration } from "./google";
import { connectorImplementation } from "./registry";
import type { GoogleApi, GoogleConnectorConfig } from "./types";

const keyPattern = /^[a-z0-9][a-z0-9._-]*$/;

export interface ConnectorDto {
  id: string;
  key: string;
  name: string;
  type: "google";
  enabled: boolean;
  enabledApis: GoogleApi[];
  oauthScopes: string[];
  oauthClientId: string;
  hasClientSecret: boolean;
  connectionCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminConnectionDto {
  id: string;
  name: string;
  owner: { id: string; name: string; email: string };
  connector: { id: string; key: string; name: string };
  accountDisplayName: string | null;
  providerAccountId: string | null;
  grantedScopes: string[];
  enabledApis: GoogleApi[];
  credentialMode: "local";
  deviceId: string;
  status: "pending" | "ready" | "reconnect_required" | "disabled" | "disconnected";
  connectedAt: string | null;
  lastLeaseAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const connectorInclude = { _count: { select: { connections: true } } } as const;
const connectionInclude = {
  owner: { select: { id: true, name: true, email: true } },
  connector: {
    select: { id: true, key: true, name: true, enabledApis: true },
  },
} as const;

export async function listConnectors(): Promise<ConnectorDto[]> {
  const rows = await db.connector.findMany({
    orderBy: [{ name: "asc" }, { key: "asc" }],
    include: connectorInclude,
  });
  return rows.map(serializeConnector);
}

export async function getConnector(id: string): Promise<ConnectorDto> {
  const row = await db.connector.findUnique({ where: { id }, include: connectorInclude });
  if (!row) throw new AdminDomainError("NOT_FOUND", "Connector not found.");
  return serializeConnector(row);
}

export async function createConnector(
  input: {
    key: string;
    name: string;
    type: "google";
    enabled: boolean;
    enabledApis: GoogleApi[];
    oauthScopes: string[];
    oauthClientId: string;
    oauthClientSecret: string;
  },
  actor: AdminActor,
): Promise<ConnectorDto> {
  const key = parseKey(input.key);
  const name = parseName(input.name);
  const config = await validateGoogleConfig({
    clientId: input.oauthClientId,
    clientSecret: input.oauthClientSecret,
    enabledApis: input.enabledApis,
    oauthScopes: input.oauthScopes,
  });
  try {
    return await db.$transaction(async (tx) => {
      await lockConfigurationChanges(tx);
      const pending = await tx.connector.create({
        data: {
          key,
          name,
          type: input.type,
          enabled: input.enabled,
          enabledApis: config.enabledApis,
          oauthScopes: config.oauthScopes,
          oauthClientId: config.clientId,
          encryptedOAuthClientSecret: "pending",
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      const row = await tx.connector.update({
        where: { id: pending.id },
        data: {
          encryptedOAuthClientSecret: sealConnectorValue(
            "connector-config",
            pending.id,
            config.clientSecret,
          ),
        },
        include: connectorInclude,
      });
      await writeConnectorAudit(tx, actor, "connector.created", row, true);
      return serializeConnector(row);
    });
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      throw new AdminDomainError("CONFLICT", `Connector ${key} already exists.`);
    }
    throw error;
  }
}

export async function updateConnector(
  input: {
    id: string;
    name: string;
    enabled: boolean;
    enabledApis: GoogleApi[];
    oauthScopes: string[];
    oauthClientId: string;
    oauthClientSecret?: string | undefined;
    expectedVersion: number;
  },
  actor: AdminActor,
): Promise<ConnectorDto> {
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    const current = await tx.connector.findUnique({ where: { id: input.id } });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Connector not found.");
    if (current.version !== input.expectedVersion) throw changed();
    const replacement = input.oauthClientSecret?.trim() || undefined;
    if (current.type !== "google") {
      throw new AdminDomainError("INVALID_PROVIDER", "Unsupported connector type.");
    }
    const config = await validateGoogleConfig({
      clientId: input.oauthClientId,
      clientSecret:
        replacement ??
        unsealConnectorValue("connector-config", current.id, current.encryptedOAuthClientSecret),
      enabledApis: input.enabledApis,
      oauthScopes: input.oauthScopes,
    });
    await tx.connectorAuthorization.deleteMany({
      where: { connection: { connectorId: current.id } },
    });
    const write = await tx.connector.updateMany({
      where: { id: current.id, version: input.expectedVersion },
      data: {
        name: parseName(input.name),
        enabled: input.enabled,
        enabledApis: config.enabledApis,
        oauthScopes: config.oauthScopes,
        oauthClientId: config.clientId,
        ...(replacement
          ? {
              encryptedOAuthClientSecret: sealConnectorValue(
                "connector-config",
                current.id,
                replacement,
              ),
            }
          : {}),
        version: { increment: 1 },
        updatedBy: actor.id,
      },
    });
    if (write.count !== 1) throw changed();
    const row = await tx.connector.findUniqueOrThrow({
      where: { id: current.id },
      include: connectorInclude,
    });
    await writeConnectorAudit(tx, actor, "connector.updated", row, Boolean(replacement));
    return serializeConnector(row);
  });
}

export async function testConnector(
  input:
    | {
        id: string;
        enabledApis: GoogleApi[];
        oauthScopes: string[];
        oauthClientId: string;
        oauthClientSecret?: string | undefined;
      }
    | {
        enabledApis: GoogleApi[];
        oauthScopes: string[];
        oauthClientId: string;
        oauthClientSecret: string;
      },
): Promise<{ status: "ok"; latencyMs: number }> {
  let stored:
    | {
        id: string;
        encryptedOAuthClientSecret: string;
      }
    | undefined;
  if ("id" in input) {
    const row = await db.connector.findUnique({
      where: { id: input.id },
      select: { id: true, type: true, encryptedOAuthClientSecret: true },
    });
    if (!row) throw new AdminDomainError("NOT_FOUND", "Connector not found.");
    if (row.type !== "google") {
      throw new AdminDomainError("INVALID_PROVIDER", "Unsupported connector type.");
    }
    stored = row;
  }
  await validateGoogleConfig({
    clientId: input.oauthClientId,
    clientSecret:
      input.oauthClientSecret?.trim() ||
      (stored
        ? unsealConnectorValue("connector-config", stored.id, stored.encryptedOAuthClientSecret)
        : ""),
    enabledApis: input.enabledApis,
    oauthScopes: input.oauthScopes,
  });
  const started = performance.now();
  try {
    await testGoogleConfiguration();
    return { status: "ok", latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  } catch {
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "Google OAuth discovery could not be validated.",
    );
  }
}

export async function deleteConnector(
  input: { id: string; expectedVersion: number },
  actor: AdminActor,
): Promise<{ id: string }> {
  return db.$transaction(async (tx) => {
    await lockConfigurationChanges(tx);
    const row = await tx.connector.findUnique({
      where: { id: input.id },
      include: connectorInclude,
    });
    if (!row) throw new AdminDomainError("NOT_FOUND", "Connector not found.");
    if (row.version !== input.expectedVersion) throw changed();
    if (row._count.connections > 0) {
      throw new AdminDomainError(
        "CONFLICT",
        "A connector with connections cannot be deleted. Disable it instead.",
      );
    }
    const deleted = await tx.connector.deleteMany({
      where: { id: row.id, version: input.expectedVersion },
    });
    if (deleted.count !== 1) throw changed();
    await writeConnectorAudit(tx, actor, "connector.deleted", row, false);
    return { id: row.id };
  });
}

export async function listAdminConnections(input: {
  page: number;
  pageSize: number;
  q?: string | undefined;
  status?: AdminConnectionDto["status"] | undefined;
  connectorId?: string | undefined;
  sort: "updatedAt.asc" | "updatedAt.desc" | "name.asc" | "name.desc";
}): Promise<{ items: AdminConnectionDto[]; total: number }> {
  const q = input.q?.trim();
  const where: Prisma.ConnectorConnectionWhereInput = {
    ...(input.status ? { status: statusForDatabase(input.status) } : {}),
    ...(input.connectorId ? { connectorId: input.connectorId } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { accountDisplayName: { contains: q, mode: "insensitive" } },
            { owner: { email: { contains: q, mode: "insensitive" } } },
            { connector: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [field, direction] = input.sort.split(".") as ["updatedAt" | "name", "asc" | "desc"];
  const [items, total] = await Promise.all([
    db.connectorConnection.findMany({
      where,
      orderBy: [{ [field]: direction }, { id: direction }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: connectionInclude,
    }),
    db.connectorConnection.count({ where }),
  ]);
  return { items: items.map(serializeAdminConnection), total };
}

export async function updateConnectionStatus(
  input: {
    id: string;
    status: "ready" | "disabled" | "reconnect_required";
    expectedVersion: number;
  },
  actor: AdminActor,
): Promise<AdminConnectionDto> {
  return db.$transaction(async (tx) => {
    const current = await tx.connectorConnection.findUnique({
      where: { id: input.id },
      include: { connector: true },
    });
    if (!current) throw new AdminDomainError("NOT_FOUND", "Connection not found.");
    if (current.version !== input.expectedVersion) {
      throw new AdminDomainError("CONFLICT", "Connection changed. Reload and try again.");
    }
    if (current.status === "DISCONNECTED") {
      throw new AdminDomainError("CONFLICT", "A disconnected connection cannot be re-enabled.");
    }
    if (
      input.status === "ready" &&
      (current.status !== "DISABLED" ||
        !current.connector.enabled ||
        !current.providerAccountId ||
        !current.connectedAt)
    ) {
      throw new AdminDomainError(
        "CONFLICT",
        "Only a previously disabled connection on an enabled connector can be re-enabled.",
      );
    }
    await tx.connectorAuthorization.deleteMany({ where: { connectionId: current.id } });
    const write = await tx.connectorConnection.updateMany({
      where: { id: current.id, version: input.expectedVersion },
      data: { status: statusForDatabase(input.status), version: { increment: 1 } },
    });
    if (write.count !== 1) {
      throw new AdminDomainError("CONFLICT", "Connection changed. Reload and try again.");
    }
    const row = await tx.connectorConnection.findUniqueOrThrow({
      where: { id: current.id },
      include: connectionInclude,
    });
    const event =
      input.status === "ready"
        ? "connection.enabled"
        : input.status === "disabled"
          ? "connection.disabled"
          : "connection.reconnect_required";
    await prismaAuditWriter.write(
      connectionAudit(actor, event, {
        ...row,
        connector: { ...current.connector, ...row.connector },
      }),
      tx,
    );
    return serializeAdminConnection(row);
  });
}

export function connectorConfig(row: {
  id: string;
  oauthClientId: string;
  encryptedOAuthClientSecret: string;
  enabledApis: string[];
  oauthScopes: string[];
}): GoogleConnectorConfig {
  return {
    clientId: row.oauthClientId,
    clientSecret: unsealConnectorValue("connector-config", row.id, row.encryptedOAuthClientSecret),
    enabledApis: row.enabledApis.map(parseApi),
    oauthScopes: row.oauthScopes,
  };
}

function serializeConnector(row: {
  id: string;
  key: string;
  name: string;
  type: string;
  enabled: boolean;
  enabledApis: string[];
  oauthScopes: string[];
  oauthClientId: string;
  encryptedOAuthClientSecret: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  _count: { connections: number };
}): ConnectorDto {
  if (row.type !== "google") throw new Error("Unsupported stored connector type");
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    enabledApis: row.enabledApis.map(parseApi),
    oauthScopes: row.oauthScopes,
    oauthClientId: row.oauthClientId,
    hasClientSecret: Boolean(row.encryptedOAuthClientSecret),
    connectionCount: row._count.connections,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeAdminConnection(row: {
  id: string;
  name: string;
  accountDisplayName: string | null;
  providerAccountId: string | null;
  grantedScopes: string[];
  credentialMode: string;
  deviceId: string;
  status: string;
  connectedAt: Date | null;
  lastLeaseAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  owner: { id: string; name: string; email: string };
  connector: { id: string; key: string; name: string; enabledApis: string[] };
}): AdminConnectionDto {
  if (row.credentialMode !== "local") throw new Error("Unsupported credential mode");
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    connector: { id: row.connector.id, key: row.connector.key, name: row.connector.name },
    accountDisplayName: row.accountDisplayName,
    providerAccountId: row.providerAccountId,
    grantedScopes: row.grantedScopes,
    enabledApis: row.connector.enabledApis.map(parseApi),
    credentialMode: row.credentialMode,
    deviceId: row.deviceId,
    status: statusForApi(row.status),
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastLeaseAt: row.lastLeaseAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseKey(raw: string): string {
  const value = raw.trim();
  if (!keyPattern.test(value) || value.length > 120) {
    throw new AdminDomainError("INVALID_PROVIDER", "Enter a valid lowercase connector key.");
  }
  return value;
}

function parseName(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 200) {
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "Connector name must contain 1 to 200 characters.",
    );
  }
  return value;
}

function parseApi(value: string): GoogleApi {
  if (value !== "gmail" && value !== "calendar") throw new Error("Unsupported stored Google API");
  return value;
}

export function statusForApi(value: string): AdminConnectionDto["status"] {
  const statuses = {
    PENDING: "pending",
    READY: "ready",
    RECONNECT_REQUIRED: "reconnect_required",
    DISABLED: "disabled",
    DISCONNECTED: "disconnected",
  } as const;
  const status = statuses[value as keyof typeof statuses];
  if (!status) throw new Error("Unsupported stored connection status");
  return status;
}

function statusForDatabase(value: AdminConnectionDto["status"]) {
  return value.toUpperCase() as
    "PENDING" | "READY" | "RECONNECT_REQUIRED" | "DISABLED" | "DISCONNECTED";
}

async function writeConnectorAudit(
  tx: Prisma.TransactionClient,
  actor: AdminActor,
  eventType: "connector.created" | "connector.updated" | "connector.deleted",
  row: {
    id: string;
    key: string;
    type: string;
    enabled: boolean;
    enabledApis: string[];
    oauthScopes: string[];
    version: number;
  },
  secretChanged: boolean,
) {
  await prismaAuditWriter.write(
    {
      eventType,
      actorType: "user",
      actorId: actor.id,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      requestId: actor.requestId,
      ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
      outcome: "success",
      subjectType: "connector",
      subjectId: row.id,
      metadata: {
        connectorKey: row.key,
        connectorType: row.type,
        enabled: row.enabled,
        enabledApis: row.enabledApis,
        oauthScopes: row.oauthScopes,
        version: row.version,
        secretChanged,
      },
    },
    tx,
  );
}

function connectionAudit(
  actor: AdminActor,
  eventType: "connection.enabled" | "connection.disabled" | "connection.reconnect_required",
  row: {
    id: string;
    ownerId: string;
    credentialMode: string;
    status: string;
    providerAccountId: string | null;
    grantedScopes: string[];
    connector: { id: string; key: string };
  },
) {
  return {
    eventType,
    actorType: "user" as const,
    actorId: actor.id,
    ...(actor.email ? { actorEmail: actor.email } : {}),
    requestId: actor.requestId,
    ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
    outcome: "success" as const,
    subjectType: "connection",
    subjectId: row.id,
    metadata: {
      connectorId: row.connector.id,
      connectorKey: row.connector.key,
      connectionId: row.id,
      ownerId: row.ownerId,
      credentialMode: row.credentialMode,
      status: statusForApi(row.status),
      ...(row.providerAccountId ? { providerAccountId: row.providerAccountId } : {}),
      grantedScopes: row.grantedScopes,
    },
  };
}

async function validateGoogleConfig(value: unknown): Promise<GoogleConnectorConfig> {
  try {
    return await connectorImplementation("google").validateConfig(value);
  } catch {
    throw new AdminDomainError(
      "INVALID_PROVIDER",
      "Choose valid Google APIs and OAuth scopes and provide valid OAuth client credentials.",
    );
  }
}

function changed() {
  return new AdminDomainError("CONFLICT", "Connector changed. Reload and try again.");
}

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}
