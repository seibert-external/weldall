-- First-class workload identities, rotating public keys, independent resource/scope
-- allowlists, and durable private_key_jwt assertion replay protection.
CREATE TABLE "WorkloadClient" (
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
    CONSTRAINT "WorkloadClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkloadClientKey" (
    "id" TEXT NOT NULL,
    "workloadClientId" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "publicJwk" JSONB NOT NULL,
    "thumbprint" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "revokedBy" TEXT,
    CONSTRAINT "WorkloadClientKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkloadAllowedResource" (
    "workloadClientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    CONSTRAINT "WorkloadAllowedResource_pkey" PRIMARY KEY ("workloadClientId", "resourceId")
);

CREATE TABLE "WorkloadAllowedScope" (
    "workloadClientId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    CONSTRAINT "WorkloadAllowedScope_pkey" PRIMARY KEY ("workloadClientId", "scopeId")
);

CREATE TABLE "WorkloadAssertionReplay" (
    "id" TEXT NOT NULL,
    "assertionHash" TEXT NOT NULL,
    "workloadClientId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkloadAssertionReplay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkloadClient_clientId_key" ON "WorkloadClient"("clientId");
CREATE INDEX "WorkloadClient_enabled_idx" ON "WorkloadClient"("enabled");
CREATE INDEX "WorkloadClient_updatedAt_idx" ON "WorkloadClient"("updatedAt");
CREATE UNIQUE INDEX "WorkloadClientKey_workloadClientId_kid_key" ON "WorkloadClientKey"("workloadClientId", "kid");
CREATE UNIQUE INDEX "WorkloadClientKey_thumbprint_key" ON "WorkloadClientKey"("thumbprint");
CREATE INDEX "WorkloadClientKey_active_idx" ON "WorkloadClientKey"("workloadClientId", "revokedAt");
CREATE INDEX "WorkloadAllowedResource_resourceId_idx" ON "WorkloadAllowedResource"("resourceId");
CREATE INDEX "WorkloadAllowedScope_scopeId_idx" ON "WorkloadAllowedScope"("scopeId");
CREATE UNIQUE INDEX "WorkloadAssertionReplay_assertionHash_key" ON "WorkloadAssertionReplay"("assertionHash");
CREATE INDEX "WorkloadAssertionReplay_expiresAt_idx" ON "WorkloadAssertionReplay"("expiresAt");
CREATE INDEX "WorkloadAssertionReplay_client_created_idx" ON "WorkloadAssertionReplay"("workloadClientId", "createdAt");

ALTER TABLE "WorkloadClientKey" ADD CONSTRAINT "WorkloadClientKey_workloadClientId_fkey" FOREIGN KEY ("workloadClientId") REFERENCES "WorkloadClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkloadAllowedResource" ADD CONSTRAINT "WorkloadAllowedResource_workloadClientId_fkey" FOREIGN KEY ("workloadClientId") REFERENCES "WorkloadClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkloadAllowedResource" ADD CONSTRAINT "WorkloadAllowedResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkloadAllowedScope" ADD CONSTRAINT "WorkloadAllowedScope_workloadClientId_fkey" FOREIGN KEY ("workloadClientId") REFERENCES "WorkloadClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkloadAllowedScope" ADD CONSTRAINT "WorkloadAllowedScope_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkloadAssertionReplay" ADD CONSTRAINT "WorkloadAssertionReplay_workloadClientId_fkey" FOREIGN KEY ("workloadClientId") REFERENCES "WorkloadClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkloadClient"
  ADD CONSTRAINT "WorkloadClient_client_id" CHECK ("clientId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT "WorkloadClient_version" CHECK ("version" > 0);
ALTER TABLE "WorkloadClientKey"
  ADD CONSTRAINT "WorkloadClientKey_kid" CHECK ("kid" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT "WorkloadClientKey_thumbprint" CHECK ("thumbprint" ~ '^[A-Za-z0-9_-]{43}$');

ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type";
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_event_type" CHECK (
    "eventType" IN (
      'id_jag.issued', 'id_jag.denied', 'id_jag.failed',
      'workload_client.created', 'workload_client.updated', 'workload_client.deactivated',
      'workload_key.registered', 'workload_key.revoked',
      'workload_access.replaced',
      'workload_token.issued', 'workload_token.denied', 'workload_token.failed',
      'user_scopes.created', 'user_scopes.replaced', 'user_scopes.deleted',
      'resource_scopes.created', 'resource_scopes.replaced', 'resource_scopes.deleted',
      'cli_settings.updated', 'skill.created', 'skill.updated', 'skill.deleted',
      'group_provider.created', 'group_provider.updated', 'group_provider.deleted',
      'group_provider.tested', 'group_scopes.created', 'group_scopes.replaced',
      'group_scopes.deleted'
    )
  ) NOT VALID;
