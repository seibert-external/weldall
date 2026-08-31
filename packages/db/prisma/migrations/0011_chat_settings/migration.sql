CREATE TABLE "ChatSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "baseUrl" TEXT NOT NULL DEFAULT 'https://provider.example.com/v1',
  "model" TEXT NOT NULL DEFAULT 'example-model',
  "encryptedApiKey" TEXT,
  "encryptionKeyVersion" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  CONSTRAINT "ChatSettings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChatSettings"
  ADD CONSTRAINT "ChatSettings_singleton" CHECK ("id" = 'default'),
  ADD CONSTRAINT "ChatSettings_base_url_length" CHECK (char_length("baseUrl") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "ChatSettings_model_length" CHECK (char_length("model") BETWEEN 1 AND 200),
  ADD CONSTRAINT "ChatSettings_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "ChatSettings_credential_pair" CHECK (("encryptedApiKey" IS NULL) = ("encryptionKeyVersion" IS NULL)),
  ADD CONSTRAINT "ChatSettings_encryption_key_version" CHECK ("encryptionKeyVersion" IS NULL OR "encryptionKeyVersion" > 0),
  ADD CONSTRAINT "ChatSettings_enabled_requires_key" CHECK (NOT "enabled" OR "encryptedApiKey" IS NOT NULL);

ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type";
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_event_type" CHECK (
    "eventType" IN (
      'id_jag.issued', 'id_jag.denied', 'id_jag.failed',
      'chat_tool.requested', 'chat_tool.succeeded', 'chat_tool.failed',
      'chat_settings.updated',
      'machine_client.created', 'machine_client.updated', 'machine_client.deactivated',
      'machine_client.deleted', 'machine_key.registered', 'machine_key.revoked',
      'machine_access.replaced', 'machine_token.issued', 'machine_token.denied',
      'machine_token.failed', 'user_scopes.created', 'user_scopes.replaced',
      'user_scopes.deleted', 'resource_scopes.created', 'resource_scopes.replaced',
      'resource_scopes.deleted', 'cli_settings.updated', 'skill.created', 'skill.updated',
      'skill.deleted', 'group_provider.created', 'group_provider.updated',
      'group_provider.deleted', 'group_provider.tested', 'group_scopes.created',
      'group_scopes.replaced', 'group_scopes.deleted', 'iac.plan.generated',
      'iac.apply.succeeded', 'iac.apply.denied', 'iac.apply.failed',
      'iac.object.imported', 'iac.object.unmanaged', 'iac.state.moved'
    )
  );
