import { createCipheriv, randomBytes } from "node:crypto";
import { PersonalConnectionStatus, Prisma, type PrismaClient } from "@prisma/client";
import { DEVELOPMENT_USERS } from "./seed.dev-users.js";

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HOUR_IN_MS = 60 * 60 * 1000;
const MINUTE_IN_MS = 60 * 1000;
const CONNECTOR_ID_PREFIX = "dev-connector-";
const CONNECTION_ID_PREFIX = "dev-connection-";
const AUDIT_ID_PREFIX = "dev-connector-audit-";

const googleScopes = {
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  gmailMetadata: "https://www.googleapis.com/auth/gmail.metadata",
} as const;

type DevelopmentConnector = {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  enabledApis: string[];
  oauthScopes: string[];
  oauthClientId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type DevelopmentConnection = {
  id: string;
  connectorId: string;
  ownerId: string;
  name: string;
  providerAccountId: string;
  accountDisplayName: string;
  grantedScopes: string[];
  deviceId: string;
  status: PersonalConnectionStatus;
  version: number;
  connectedAt: Date;
  lastLeaseAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Seeded connector lifecycle examples for the administration overview and detail pages. */
export async function seedDevelopmentConnectors(
  db: PrismaClient,
  actor = "development-seed",
): Promise<void> {
  const now = Date.now();
  const ago = (days: number, hours = 0) => new Date(now - days * DAY_IN_MS - hours * HOUR_IN_MS);
  const connectors: DevelopmentConnector[] = [
    {
      id: `${CONNECTOR_ID_PREFIX}google-workspace`,
      key: "dev-google-workspace",
      name: "Google Workspace (demo)",
      enabled: true,
      enabledApis: ["calendar", "gmail"],
      oauthScopes: [googleScopes.calendar, googleScopes.gmail],
      oauthClientId: "demo-workspace.apps.googleusercontent.com",
      version: 3,
      createdAt: ago(280),
      updatedAt: ago(45),
    },
    {
      id: `${CONNECTOR_ID_PREFIX}google-calendar`,
      key: "dev-google-calendar",
      name: "Google Calendar (demo)",
      enabled: true,
      enabledApis: ["calendar"],
      oauthScopes: [googleScopes.calendar],
      oauthClientId: "demo-calendar.apps.googleusercontent.com",
      version: 1,
      createdAt: ago(120),
      updatedAt: ago(120),
    },
  ];

  const users = Object.fromEntries(DEVELOPMENT_USERS.map((user) => [user.id, user]));
  const userId = (slug: string) => `dev-user-${slug}`;
  const connections: DevelopmentConnection[] = [
    {
      id: `${CONNECTION_ID_PREFIX}jane-google-work-current`,
      connectorId: connectors[0]!.id,
      ownerId: userId("jane-adams"),
      name: "google-work",
      providerAccountId: "google-jane-adams",
      accountDisplayName: "jane.adams@example.com",
      grantedScopes: [googleScopes.calendar, googleScopes.gmail],
      deviceId: "dev-device-jane-adams-current-001",
      status: PersonalConnectionStatus.READY,
      version: 4,
      connectedAt: ago(31),
      lastLeaseAt: ago(0, 1),
      createdAt: ago(32),
      updatedAt: ago(0, 1),
    },
    {
      id: `${CONNECTION_ID_PREFIX}omar-team-calendar`,
      connectorId: connectors[1]!.id,
      ownerId: userId("omar-haddad"),
      name: "team-calendar",
      providerAccountId: "google-omar-haddad",
      accountDisplayName: "omar.haddad@example.com",
      grantedScopes: [googleScopes.calendar],
      deviceId: "dev-device-omar-haddad-current-001",
      status: PersonalConnectionStatus.READY,
      version: 2,
      connectedAt: ago(18),
      lastLeaseAt: ago(0, 3),
      createdAt: ago(19),
      updatedAt: ago(0, 3),
    },
    {
      id: `${CONNECTION_ID_PREFIX}sofia-gmail-archive`,
      connectorId: connectors[0]!.id,
      ownerId: userId("sofia-marchetti"),
      name: "gmail-archive",
      providerAccountId: "google-sofia-marchetti",
      accountDisplayName: "sofia.marchetti@example.com",
      grantedScopes: [googleScopes.gmailMetadata],
      deviceId: "dev-device-sofia-marchetti-001",
      status: PersonalConnectionStatus.RECONNECT_REQUIRED,
      version: 5,
      connectedAt: ago(95),
      lastLeaseAt: ago(4),
      createdAt: ago(96),
      updatedAt: ago(3),
    },
    {
      id: `${CONNECTION_ID_PREFIX}mia-shared-calendar`,
      connectorId: connectors[1]!.id,
      ownerId: userId("mia-andersen"),
      name: "shared-calendar",
      providerAccountId: "google-mia-andersen",
      accountDisplayName: "mia.andersen@example.com",
      grantedScopes: [googleScopes.calendar],
      deviceId: "dev-device-mia-andersen-current-001",
      status: PersonalConnectionStatus.READY,
      version: 2,
      connectedAt: ago(44),
      lastLeaseAt: null,
      createdAt: ago(45),
      updatedAt: ago(44),
    },
  ];

  for (const connection of connections) {
    if (!users[connection.ownerId]) {
      throw new Error(`Development connection ${connection.id} references an unseeded user.`);
    }
  }

  const connectorIds = connectors.map(({ id }) => id);
  const connectionIds = connections.map(({ id }) => id);
  await db.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany({ where: { id: { startsWith: AUDIT_ID_PREFIX } } });
    await tx.personalConnection.deleteMany({
      where: { id: { startsWith: CONNECTION_ID_PREFIX, notIn: connectionIds } },
    });
    await tx.connector.deleteMany({
      where: { id: { startsWith: CONNECTOR_ID_PREFIX, notIn: connectorIds } },
    });

    for (const connector of connectors) {
      const encryptedOAuthClientSecret = sealDevelopmentConnectorSecret(
        connector.id,
        `development-only-${connector.key}-secret`,
      );
      await tx.connector.upsert({
        where: { id: connector.id },
        create: {
          ...connector,
          type: "google",
          encryptedOAuthClientSecret,
          createdBy: actor,
          updatedBy: actor,
        },
        update: {
          key: connector.key,
          name: connector.name,
          type: "google",
          enabled: connector.enabled,
          enabledApis: connector.enabledApis,
          oauthScopes: connector.oauthScopes,
          oauthClientId: connector.oauthClientId,
          encryptedOAuthClientSecret,
          version: connector.version,
          updatedAt: connector.updatedAt,
          updatedBy: actor,
        },
      });
    }

    for (const connection of connections) {
      await tx.personalConnection.upsert({
        where: { id: connection.id },
        create: connection,
        update: {
          connectorId: connection.connectorId,
          ownerId: connection.ownerId,
          name: connection.name,
          providerAccountId: connection.providerAccountId,
          accountDisplayName: connection.accountDisplayName,
          grantedScopes: connection.grantedScopes,
          deviceId: connection.deviceId,
          status: connection.status,
          version: connection.version,
          connectedAt: connection.connectedAt,
          lastLeaseAt: connection.lastLeaseAt,
          createdAt: connection.createdAt,
          updatedAt: connection.updatedAt,
        },
      });
    }

    await tx.auditEvent.createMany({
      data: developmentConnectorAuditEvents(connectors, connections, users, actor),
    });
  });
}

function developmentConnectorAuditEvents(
  connectors: DevelopmentConnector[],
  connections: DevelopmentConnection[],
  users: Record<string, (typeof DEVELOPMENT_USERS)[number]>,
  actor: string,
): Prisma.AuditEventCreateManyInput[] {
  const events: Prisma.AuditEventCreateManyInput[] = [];
  const push = (
    id: string,
    event: Omit<Prisma.AuditEventCreateManyInput, "id" | "requestId" | "createdAt">,
  ) => {
    events.push({
      id: `${AUDIT_ID_PREFIX}${id}`,
      requestId: `${AUDIT_ID_PREFIX}${id}`,
      createdAt: event.occurredAt,
      ...event,
    });
  };

  for (const connector of connectors) {
    push(`${connector.id}-created`, {
      eventType: "connector.created",
      occurredAt: connector.createdAt,
      actorType: "user",
      actorId: actor,
      outcome: "success",
      subjectType: "connector",
      subjectId: connector.id,
      metadata: {
        connectorKey: connector.key,
        connectorType: "google",
        enabled: connector.enabled,
        enabledApis: connector.enabledApis,
        oauthScopes: connector.oauthScopes,
        version: 1,
        secretChanged: true,
      },
    });
    if (connector.version > 1) {
      push(`${connector.id}-updated`, {
        eventType: "connector.updated",
        occurredAt: connector.updatedAt,
        actorType: "user",
        actorId: actor,
        outcome: "success",
        subjectType: "connector",
        subjectId: connector.id,
        metadata: {
          connectorKey: connector.key,
          connectorType: "google",
          enabled: connector.enabled,
          enabledApis: connector.enabledApis,
          oauthScopes: connector.oauthScopes,
          version: connector.version,
          secretChanged: false,
        },
      });
    }
  }

  for (const connection of connections) {
    const owner = users[connection.ownerId]!;
    const connector = connectors.find(({ id }) => id === connection.connectorId)!;
    const connectionMetadata = (status?: "ready" | "reconnect_required") => ({
      connectorId: connector.id,
      connectorKey: connector.key,
      connectionId: connection.id,
      connectionName: connection.name,
      ownerId: connection.ownerId,
      ...(status ? { status } : {}),
      providerAccountId: connection.providerAccountId,
      accountDisplayName: connection.accountDisplayName,
      grantedScopes: connection.grantedScopes,
    });
    const userEvent = (
      suffix: string,
      eventType: string,
      occurredAt: Date,
      status: "ready" | "reconnect_required" | undefined,
      extra: Partial<Prisma.AuditEventCreateManyInput> = {},
    ) =>
      push(`${connection.id}-${suffix}`, {
        eventType,
        occurredAt,
        actorType: "user",
        actorId: owner.id,
        actorEmail: owner.email,
        outcome: "success",
        subjectType: "connection",
        subjectId: connection.id,
        metadata: connectionMetadata(status),
        ...extra,
      });

    push(`${connection.id}-authorization-started`, {
      eventType: "connection.authorization_started",
      occurredAt: new Date(connection.createdAt.getTime() + MINUTE_IN_MS),
      actorType: "user",
      actorId: owner.id,
      actorEmail: owner.email,
      outcome: "success",
      subjectType: "connection",
      subjectId: connection.id,
      metadata: {
        connectorId: connector.id,
        connectorKey: connector.key,
        connectionId: connection.id,
        connectionName: connection.name,
        ownerId: connection.ownerId,
        authorizationMode: "connect",
      },
    });

    if (connection.connectedAt) {
      userEvent("connected", "connection.connected", connection.connectedAt, "ready");
    }
    if (connection.lastLeaseAt) {
      push(`${connection.id}-lease-issued`, {
        eventType: "connection_lease.issued",
        occurredAt: connection.lastLeaseAt,
        actorType: "user",
        actorId: owner.id,
        actorEmail: owner.email,
        outcome: "success",
        subjectType: "connection",
        subjectId: connection.id,
        metadata: {
          connectorId: connector.id,
          connectionId: connection.id,
          ownerId: connection.ownerId,
          method: "GET",
          host: connector.enabledApis.includes("gmail")
            ? "gmail.googleapis.com"
            : "www.googleapis.com",
          path: connector.enabledApis.includes("gmail")
            ? "/gmail/v1/users/me/messages"
            : "/calendar/v3/calendars/primary/events",
        },
      });
    }

    if (connection.status === PersonalConnectionStatus.RECONNECT_REQUIRED) {
      userEvent(
        "refresh-failed",
        "connection_credential.refresh_failed",
        connection.updatedAt,
        "reconnect_required",
        { outcome: "failed", reasonCode: "invalid_grant" },
      );
    }
  }

  const disconnectedOwner = users["dev-user-noah-fischer"]!;
  const disconnectedConnector = connectors[0]!;
  push("removed-connection-disconnected", {
    eventType: "connection.disconnected",
    occurredAt: new Date(Date.now() - 120 * DAY_IN_MS),
    actorType: "user",
    actorId: actor,
    outcome: "success",
    subjectType: "connection",
    subjectId: `${CONNECTION_ID_PREFIX}noah-former-google`,
    metadata: {
      connectorId: disconnectedConnector.id,
      connectorKey: disconnectedConnector.key,
      connectionId: `${CONNECTION_ID_PREFIX}noah-former-google`,
      connectionName: "former-google",
      ownerId: disconnectedOwner.id,
      status: "ready",
      providerAccountId: "google-noah-fischer",
      accountDisplayName: "noah.fischer@example.com",
      grantedScopes: [googleScopes.calendar],
      revocationAttempted: false,
    },
  });

  return events;
}

function sealDevelopmentConnectorSecret(id: string, value: string): string {
  const encodedKey = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error(
      "WELDALL_CREDENTIAL_ENCRYPTION_KEY is required for development connector seeds. Generate .env with pnpm secrets:generate.",
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`weldall-connector:v1:connector-config:${id}`));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}
