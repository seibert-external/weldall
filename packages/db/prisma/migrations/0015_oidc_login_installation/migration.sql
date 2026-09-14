ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_event_type";
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_event_type" CHECK ("eventType" IN (
  'id_jag.issued', 'id_jag.denied', 'id_jag.failed',
  'chat_tool.requested', 'chat_tool.succeeded', 'chat_tool.failed', 'chat_settings.updated',
  'machine_client.created', 'machine_client.updated', 'machine_client.deactivated',
  'machine_client.deleted', 'machine_key.registered', 'machine_key.revoked',
  'machine_access.replaced', 'machine_token.issued', 'machine_token.denied', 'machine_token.failed',
  'user_scopes.created', 'user_scopes.replaced', 'user_scopes.deleted',
  'resource_scopes.created', 'resource_scopes.replaced', 'resource_scopes.deleted',
  'cli_settings.updated', 'skill.created', 'skill.updated', 'skill.deleted',
  'group_provider.created', 'group_provider.updated', 'group_provider.deleted', 'group_provider.tested',
  'group_scopes.created', 'group_scopes.replaced', 'group_scopes.deleted',
  'iac.plan.generated', 'iac.apply.succeeded', 'iac.apply.denied', 'iac.apply.failed',
  'iac.object.imported', 'iac.object.unmanaged', 'iac.state.moved',
  'login.installation.completed', 'login.provider.saved'
));
CREATE TYPE "LoginInstallationState" AS ENUM ('UNINITIALIZED', 'COMPLETED');
CREATE TABLE "LoginInstallation" (
  "id" TEXT NOT NULL DEFAULT 'default' PRIMARY KEY CHECK ("id" = 'default'),
  "state" "LoginInstallationState" NOT NULL DEFAULT 'UNINITIALIZED',
  "completedAdminUserId" TEXT REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "completedAt" TIMESTAMP(3),
  CHECK (("state" = 'UNINITIALIZED' AND "completedAdminUserId" IS NULL AND "completedAt" IS NULL) OR
         ("state" = 'COMPLETED' AND "completedAdminUserId" IS NOT NULL AND "completedAt" IS NOT NULL))
);
INSERT INTO "LoginInstallation" ("id") VALUES ('default') ON CONFLICT DO NOTHING;
CREATE TABLE "LoginProvider" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "buttonLabel" TEXT NOT NULL,
  "buttonColor" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "issuer" TEXT NOT NULL,
  "discoveryUrl" TEXT,
  "clientId" TEXT NOT NULL,
  "encryptedClientSecret" TEXT NOT NULL,
  "tokenEndpointAuthMethod" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "allowedEmailDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "validatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL
);
CREATE INDEX "LoginProvider_enabled_sortOrder_id_idx" ON "LoginProvider"("enabled", "sortOrder", "id");
CREATE TABLE "LoginAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "providerVersion" INTEGER,
  "mode" TEXT NOT NULL CHECK ("mode" IN ('login', 'setup', 'setup-test', 'provider-test')),
  "browserHash" TEXT NOT NULL,
  "encryptedPayload" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LoginAttempt_expiresAt_idx" ON "LoginAttempt"("expiresAt");

-- Intentional one-way cutover: retain users, grants, sessions and all other identities.
DELETE FROM "Account" WHERE "providerId" = 'google' AND "issuer" = 'https://accounts.google.com';
