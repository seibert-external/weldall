-- First-class machine identities, rotating public keys, and independent
-- resource/scope allowlists. Assertion and DPoP replay protection remains
-- process-local and is deliberately not persisted in Prisma.
CREATE TABLE "MachineClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    CONSTRAINT "MachineClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MachineClientKey" (
    "id" TEXT NOT NULL,
    "machineClientId" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "publicJwk" JSONB NOT NULL,
    "thumbprint" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "revokedBy" TEXT,
    CONSTRAINT "MachineClientKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MachineAllowedResource" (
    "machineClientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    CONSTRAINT "MachineAllowedResource_pkey" PRIMARY KEY ("machineClientId", "resourceId")
);

CREATE TABLE "MachineAllowedScope" (
    "machineClientId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    CONSTRAINT "MachineAllowedScope_pkey" PRIMARY KEY ("machineClientId", "scopeId")
);

CREATE UNIQUE INDEX "MachineClient_clientId_key" ON "MachineClient"("clientId");
CREATE INDEX "MachineClient_enabled_idx" ON "MachineClient"("enabled");
CREATE INDEX "MachineClient_updatedAt_idx" ON "MachineClient"("updatedAt");
CREATE UNIQUE INDEX "MachineClientKey_machineClientId_kid_key" ON "MachineClientKey"("machineClientId", "kid");
CREATE UNIQUE INDEX "MachineClientKey_thumbprint_key" ON "MachineClientKey"("thumbprint");
CREATE INDEX "MachineClientKey_active_idx" ON "MachineClientKey"("machineClientId", "revokedAt");
CREATE INDEX "MachineAllowedResource_resourceId_idx" ON "MachineAllowedResource"("resourceId");
CREATE INDEX "MachineAllowedScope_scopeId_idx" ON "MachineAllowedScope"("scopeId");

ALTER TABLE "MachineClientKey" ADD CONSTRAINT "MachineClientKey_machineClientId_fkey" FOREIGN KEY ("machineClientId") REFERENCES "MachineClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineAllowedResource" ADD CONSTRAINT "MachineAllowedResource_machineClientId_fkey" FOREIGN KEY ("machineClientId") REFERENCES "MachineClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineAllowedResource" ADD CONSTRAINT "MachineAllowedResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MachineAllowedScope" ADD CONSTRAINT "MachineAllowedScope_machineClientId_fkey" FOREIGN KEY ("machineClientId") REFERENCES "MachineClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineAllowedScope" ADD CONSTRAINT "MachineAllowedScope_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MachineClient"
  ADD CONSTRAINT "MachineClient_client_id" CHECK ("clientId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT "MachineClient_version" CHECK ("version" > 0);
ALTER TABLE "MachineClientKey"
  ADD CONSTRAINT "MachineClientKey_kid" CHECK ("kid" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT "MachineClientKey_thumbprint" CHECK ("thumbprint" ~ '^[A-Za-z0-9_-]{43}$');

-- The baseline used the former product term for deployment bootstrap actors.
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_actor_type";
UPDATE "AuditEvent" SET "actorType" = 'machine' WHERE "actorType" = 'workload';
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_actor_type" CHECK (
    "actorType" IN ('user', 'oauth_client', 'machine', 'anonymous')
  );

ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type";
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_event_type" CHECK (
    "eventType" IN (
      'id_jag.issued', 'id_jag.denied', 'id_jag.failed',
      'machine_client.created', 'machine_client.updated', 'machine_client.deactivated',
      'machine_key.registered', 'machine_key.revoked',
      'machine_access.replaced',
      'machine_token.issued', 'machine_token.denied', 'machine_token.failed',
      'user_scopes.created', 'user_scopes.replaced', 'user_scopes.deleted',
      'resource_scopes.created', 'resource_scopes.replaced', 'resource_scopes.deleted',
      'cli_settings.updated', 'skill.created', 'skill.updated', 'skill.deleted',
      'group_provider.created', 'group_provider.updated', 'group_provider.deleted',
      'group_provider.tested', 'group_scopes.created', 'group_scopes.replaced',
      'group_scopes.deleted'
    )
  ) NOT VALID;
