-- CreateEnum
CREATE TYPE "PersonalConnectionStatus" AS ENUM ('READY', 'RECONNECT_REQUIRED');

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledApis" TEXT[] NOT NULL,
    "oauthScopes" TEXT[] NOT NULL,
    "oauthClientId" TEXT NOT NULL,
    "encryptedOAuthClientSecret" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalConnection" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "accountDisplayName" TEXT NOT NULL,
    "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "deviceId" TEXT NOT NULL,
    "status" "PersonalConnectionStatus" NOT NULL DEFAULT 'READY',
    "version" INTEGER NOT NULL DEFAULT 1,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLeaseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalConnectionAuthorization" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "connectionName" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "encryptedCredentials" TEXT,
    "mode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "callbackConsumedAt" TIMESTAMP(3),
    "credentialsConsumedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalConnectionAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Connector_key_key" ON "Connector"("key");
CREATE INDEX "Connector_enabled_idx" ON "Connector"("enabled");
CREATE INDEX "Connector_updatedAt_idx" ON "Connector"("updatedAt");
CREATE UNIQUE INDEX "PersonalConnection_ownerId_name_key" ON "PersonalConnection"("ownerId", "name");
CREATE UNIQUE INDEX "PersonalConnection_connectorId_ownerId_providerAccountId_key" ON "PersonalConnection"("connectorId", "ownerId", "providerAccountId");
CREATE INDEX "PersonalConnection_connectorId_idx" ON "PersonalConnection"("connectorId");
CREATE INDEX "PersonalConnection_ownerId_status_idx" ON "PersonalConnection"("ownerId", "status");
CREATE INDEX "PersonalConnection_updatedAt_idx" ON "PersonalConnection"("updatedAt");
CREATE UNIQUE INDEX "PersonalConnectionAuthorization_connectionId_key" ON "PersonalConnectionAuthorization"("connectionId");
CREATE UNIQUE INDEX "PersonalConnectionAuthorization_stateHash_key" ON "PersonalConnectionAuthorization"("stateHash");
CREATE UNIQUE INDEX "PersonalConnectionAuthorization_ownerId_connectionName_key" ON "PersonalConnectionAuthorization"("ownerId", "connectionName");
CREATE INDEX "PersonalConnectionAuthorization_expiresAt_idx" ON "PersonalConnectionAuthorization"("expiresAt");

-- AddForeignKey
ALTER TABLE "PersonalConnection" ADD CONSTRAINT "PersonalConnection_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PersonalConnection" ADD CONSTRAINT "PersonalConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonalConnectionAuthorization" ADD CONSTRAINT "PersonalConnectionAuthorization_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonalConnectionAuthorization" ADD CONSTRAINT "PersonalConnectionAuthorization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type";
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_event_type" CHECK (
    "eventType" IN (
      'login.installation.completed', 'login.provider.saved', 'id_jag.issued',
      'id_jag.denied', 'id_jag.failed', 'machine_client.created',
      'machine_client.updated', 'machine_client.deactivated', 'machine_client.deleted',
      'machine_key.registered', 'machine_key.revoked', 'machine_access.replaced',
      'machine_token.issued', 'machine_token.denied', 'machine_token.failed',
      'user_scopes.created', 'user_scopes.replaced', 'user_scopes.deleted',
      'resource_scopes.created', 'resource_scopes.replaced', 'resource_scopes.deleted',
      'cli_settings.updated', 'skill.created', 'skill.updated',
      'skill.deleted', 'group_provider.created', 'group_provider.updated',
      'group_provider.deleted', 'group_provider.tested', 'group_scopes.created',
      'group_scopes.replaced', 'group_scopes.deleted', 'connector.created',
      'connector.updated', 'connector.deleted', 'connection.authorization_started',
      'connection.connected', 'connection.authorization_failed', 'connection.reconnected',
      'connection.disconnected',
      'connection_credential.refreshed',
      'connection_credential.refresh_failed', 'connection_lease.issued',
      'connection_lease.denied', 'connection_lease.failed', 'iac.plan.generated',
      'iac.apply.succeeded', 'iac.apply.denied', 'iac.apply.failed',
      'iac.object.imported', 'iac.object.unmanaged', 'iac.state.moved'
    )
  );
