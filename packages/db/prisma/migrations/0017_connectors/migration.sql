-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('PENDING', 'READY', 'RECONNECT_REQUIRED', 'DISABLED', 'DISCONNECTED');

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
CREATE TABLE "ConnectorConnection" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "accountDisplayName" TEXT,
    "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "credentialMode" TEXT NOT NULL DEFAULT 'local',
    "deviceId" TEXT NOT NULL,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "connectedAt" TIMESTAMP(3),
    "lastLeaseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorAuthorization" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "encryptedCredentials" TEXT,
    "mode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "callbackConsumedAt" TIMESTAMP(3),
    "credentialsConsumedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectorAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Connector_key_key" ON "Connector"("key");
CREATE INDEX "Connector_enabled_idx" ON "Connector"("enabled");
CREATE INDEX "Connector_updatedAt_idx" ON "Connector"("updatedAt");
CREATE UNIQUE INDEX "ConnectorConnection_ownerId_name_key" ON "ConnectorConnection"("ownerId", "name");
CREATE UNIQUE INDEX "ConnectorConnection_connectorId_ownerId_providerAccountId_key" ON "ConnectorConnection"("connectorId", "ownerId", "providerAccountId");
CREATE INDEX "ConnectorConnection_connectorId_idx" ON "ConnectorConnection"("connectorId");
CREATE INDEX "ConnectorConnection_ownerId_status_idx" ON "ConnectorConnection"("ownerId", "status");
CREATE INDEX "ConnectorConnection_updatedAt_idx" ON "ConnectorConnection"("updatedAt");
CREATE UNIQUE INDEX "ConnectorAuthorization_connectionId_key" ON "ConnectorAuthorization"("connectionId");
CREATE UNIQUE INDEX "ConnectorAuthorization_stateHash_key" ON "ConnectorAuthorization"("stateHash");
CREATE INDEX "ConnectorAuthorization_expiresAt_idx" ON "ConnectorAuthorization"("expiresAt");

-- AddForeignKey
ALTER TABLE "ConnectorConnection" ADD CONSTRAINT "ConnectorConnection_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConnectorConnection" ADD CONSTRAINT "ConnectorConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorAuthorization" ADD CONSTRAINT "ConnectorAuthorization_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ConnectorConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
      'connection.disconnected', 'connection.enabled', 'connection.disabled',
      'connection.reconnect_required', 'connection_credential.refreshed',
      'connection_credential.refresh_failed', 'connection_lease.issued',
      'connection_lease.denied', 'connection_lease.failed', 'iac.plan.generated',
      'iac.apply.succeeded', 'iac.apply.denied', 'iac.apply.failed',
      'iac.object.imported', 'iac.object.unmanaged', 'iac.state.moved'
    )
  );
