-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('READY', 'REFRESHING', 'RECONNECT_REQUIRED', 'REVOCATION_PENDING', 'DISCONNECTED');

CREATE TYPE "EnvelopeProvider" AS ENUM ('LOCAL_ENV', 'OPENBAO');

-- AlterEnum
ALTER TYPE "IacPrimitiveKind" ADD VALUE 'CONNECTOR';

-- AlterTable
ALTER TABLE "IacObjectBinding" ADD COLUMN "connectorId" TEXT;

-- CreateTable
CREATE TABLE "EncryptedValue" (
    "id" TEXT NOT NULL,
    "provider" "EnvelopeProvider" NOT NULL,
    "wrappedDek" JSONB NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "context" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "EncryptedValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "providerConfig" JSONB NOT NULL,
    "envelopeProvider" "EnvelopeProvider" NOT NULL,
    "encryptedProviderSecrets" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "providerSelection" JSONB NOT NULL,
    "providerGrant" JSONB NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'READY',
    "version" INTEGER NOT NULL DEFAULT 1,
    "credentialId" TEXT,
    "refreshStartedAt" TIMESTAMP(3),
    "revocationError" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "rateWindow" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rateCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionAuthorization" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "connectionId" TEXT,
    "connectionVersion" INTEGER,
    "connectorVersion" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SETUP',
    "providerSelection" JSONB NOT NULL,
    "stateHash" TEXT,
    "payloadId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Connector_key_key" ON "Connector"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_credentialId_key" ON "Connection"("credentialId");

-- CreateIndex
CREATE INDEX "Connection_connectorId_status_idx" ON "Connection"("connectorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_ownerId_name_key" ON "Connection"("ownerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionAuthorization_stateHash_key" ON "ConnectionAuthorization"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionAuthorization_payloadId_key" ON "ConnectionAuthorization"("payloadId");

-- CreateIndex
CREATE INDEX "ConnectionAuthorization_expiresAt_idx" ON "ConnectionAuthorization"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IacObjectBinding_connectorId_key" ON "IacObjectBinding"("connectorId");

-- AddForeignKey
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "EncryptedValue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAuthorization" ADD CONSTRAINT "ConnectionAuthorization_payloadId_fkey" FOREIGN KEY ("payloadId") REFERENCES "EncryptedValue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Extend main's CHECK constraints (not representable in Prisma's schema).
-- Preserve typed single-target bindings and tombstones for every existing primitive.
ALTER TABLE "IacObjectBinding" DROP CONSTRAINT "IacObjectBinding_kind_target_check";
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_kind_target_check" CHECK (
  num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId", "skillId", "connectorId") = 0
  OR (
    num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId", "skillId", "connectorId") = 1
    AND (
      ("kind"::text = 'SCOPE' AND "scopeId" IS NOT NULL)
      OR ("kind"::text = 'RESOURCE' AND "resourceId" IS NOT NULL)
      OR ("kind"::text = 'MACHINE' AND "machineClientId" IS NOT NULL)
      OR ("kind"::text = 'EMAIL_ASSIGNMENT' AND "emailAssignmentId" IS NOT NULL)
      OR ("kind"::text = 'GROUP_ASSIGNMENT' AND "groupAssignmentId" IS NOT NULL)
      OR ("kind"::text = 'SKILL' AND "skillId" IS NOT NULL)
      OR ("kind"::text = 'CONNECTOR' AND "connectorId" IS NOT NULL)
    )
  )
);

ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type";
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_event_type" CHECK (
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
    'group_scopes.replaced', 'group_scopes.deleted', 'iac.plan.generated',
    'iac.apply.succeeded', 'iac.apply.denied', 'iac.apply.failed',
    'iac.object.imported', 'iac.object.unmanaged', 'iac.state.moved',
    'connector.configuration', 'connector.lifecycle', 'connector.request'
  )
);
