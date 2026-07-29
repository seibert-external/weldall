CREATE TABLE "GroupProvider" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "adapterType" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "encryptedToken" TEXT NOT NULL,
  "encryptionKeyVersion" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  CONSTRAINT "GroupProvider_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupProvider_key_format" CHECK (
    "key" ~ '^[a-z0-9][a-z0-9._-]*$' AND char_length("key") <= 120
  ),
  CONSTRAINT "GroupProvider_name_length" CHECK (
    char_length(btrim("name")) BETWEEN 1 AND 200
  ),
  CONSTRAINT "GroupProvider_adapter_type" CHECK ("adapterType" IN ('management-api-v1')),
  CONSTRAINT "GroupProvider_base_url_length" CHECK (
    char_length("baseUrl") BETWEEN 1 AND 2000
  ),
  CONSTRAINT "GroupProvider_encrypted_token_present" CHECK (
    char_length("encryptedToken") > 0
  ),
  CONSTRAINT "GroupProvider_version" CHECK ("version" > 0),
  CONSTRAINT "GroupProvider_encryption_key_version" CHECK ("encryptionKeyVersion" > 0)
);

CREATE TABLE "GroupScopeAssignment" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "groupName" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  CONSTRAINT "GroupScopeAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupScopeAssignment_group_id_length" CHECK (
    char_length(btrim("groupId")) BETWEEN 1 AND 191
  ),
  CONSTRAINT "GroupScopeAssignment_group_name_length" CHECK (
    char_length(btrim("groupName")) BETWEEN 1 AND 191
  ),
  CONSTRAINT "GroupScopeAssignment_version" CHECK ("version" > 0)
);

CREATE TABLE "GroupScopeGrant" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT NOT NULL,
  CONSTRAINT "GroupScopeGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupProvider_key_key" ON "GroupProvider"("key");
CREATE INDEX "GroupProvider_enabled_idx" ON "GroupProvider"("enabled");
CREATE INDEX "GroupProvider_updatedAt_idx" ON "GroupProvider"("updatedAt");
CREATE UNIQUE INDEX "GroupScopeAssignment_providerId_groupId_key" ON "GroupScopeAssignment"("providerId", "groupId");
CREATE INDEX "GroupScopeAssignment_updatedAt_idx" ON "GroupScopeAssignment"("updatedAt");
CREATE UNIQUE INDEX "GroupScopeGrant_assignmentId_scopeId_key" ON "GroupScopeGrant"("assignmentId", "scopeId");
CREATE INDEX "GroupScopeGrant_scopeId_idx" ON "GroupScopeGrant"("scopeId");

ALTER TABLE "GroupScopeAssignment" ADD CONSTRAINT "GroupScopeAssignment_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "GroupProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupScopeGrant" ADD CONSTRAINT "GroupScopeGrant_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "GroupScopeAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupScopeGrant" ADD CONSTRAINT "GroupScopeGrant_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type";
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_event_type" CHECK (
  "eventType" IN (
    'id_jag.issued', 'id_jag.denied', 'id_jag.failed',
    'user_scopes.created', 'user_scopes.replaced', 'user_scopes.deleted',
    'resource_scopes.created', 'resource_scopes.replaced', 'resource_scopes.deleted',
    'cli_settings.updated', 'skill.created', 'skill.updated', 'skill.deleted',
    'group_provider.created', 'group_provider.updated', 'group_provider.deleted',
    'group_provider.tested', 'group_scopes.created', 'group_scopes.replaced',
    'group_scopes.deleted'
  )
) NOT VALID;
