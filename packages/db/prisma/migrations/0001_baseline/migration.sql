-- Squashed greenfield baseline: schema, application catalogs, and downstream resource registry.


-- Previous migration: packages/db/prisma/migrations/0001_initial/migration.sql
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Jwks" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT,
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" TEXT[],
    "postLogoutRedirectUris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "backchannelLogoutUri" TEXT,
    "backchannelLogoutSessionRequired" BOOLEAN,
    "tokenEndpointAuthMethod" TEXT,
    "jwks" TEXT,
    "jwksUri" TEXT,
    "grantTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "responseTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "public" BOOLEAN,
    "type" TEXT,
    "requirePKCE" BOOLEAN,
    "dpopBoundAccessTokens" BOOLEAN NOT NULL DEFAULT false,
    "referenceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthResource" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenTtl" INTEGER,
    "refreshTokenTtl" INTEGER,
    "signingAlgorithm" TEXT,
    "signingKeyId" TEXT,
    "allowedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customClaims" JSONB,
    "dpopBoundAccessTokensRequired" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthClientResource" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OauthClientResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthRefreshToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "rotationReplayResponse" TEXT,
    "rotationReplayExpiresAt" TIMESTAMP(3),
    "authTime" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "OauthRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthAccessToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refreshId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "OauthAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthConsent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "referenceId" TEXT,
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthClientAssertion" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthClientAssertion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthDeviceRefreshBinding" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dpopJkt" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "replacementHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthDeviceRefreshBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "OauthClient_clientId_key" ON "OauthClient"("clientId");

-- CreateIndex
CREATE INDEX "OauthClient_userId_idx" ON "OauthClient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OauthResource_identifier_key" ON "OauthResource"("identifier");

-- CreateIndex
CREATE INDEX "OauthClientResource_clientId_idx" ON "OauthClientResource"("clientId");

-- CreateIndex
CREATE INDEX "OauthClientResource_resourceId_idx" ON "OauthClientResource"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "OauthRefreshToken_token_key" ON "OauthRefreshToken"("token");

-- CreateIndex
CREATE INDEX "OauthRefreshToken_clientId_idx" ON "OauthRefreshToken"("clientId");

-- CreateIndex
CREATE INDEX "OauthRefreshToken_sessionId_idx" ON "OauthRefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "OauthRefreshToken_userId_idx" ON "OauthRefreshToken"("userId");

-- CreateIndex
CREATE INDEX "OauthRefreshToken_authorizationCodeId_idx" ON "OauthRefreshToken"("authorizationCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "OauthAccessToken_token_key" ON "OauthAccessToken"("token");

-- CreateIndex
CREATE INDEX "OauthAccessToken_clientId_idx" ON "OauthAccessToken"("clientId");

-- CreateIndex
CREATE INDEX "OauthAccessToken_sessionId_idx" ON "OauthAccessToken"("sessionId");

-- CreateIndex
CREATE INDEX "OauthAccessToken_userId_idx" ON "OauthAccessToken"("userId");

-- CreateIndex
CREATE INDEX "OauthAccessToken_authorizationCodeId_idx" ON "OauthAccessToken"("authorizationCodeId");

-- CreateIndex
CREATE INDEX "OauthAccessToken_refreshId_idx" ON "OauthAccessToken"("refreshId");

-- CreateIndex
CREATE INDEX "OauthConsent_clientId_idx" ON "OauthConsent"("clientId");

-- CreateIndex
CREATE INDEX "OauthConsent_userId_idx" ON "OauthConsent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthDeviceRefreshBinding_tokenHash_key" ON "OAuthDeviceRefreshBinding"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthDeviceRefreshBinding_replacementHash_key" ON "OAuthDeviceRefreshBinding"("replacementHash");

-- CreateIndex
CREATE INDEX "OAuthDeviceRefreshBinding_familyId_idx" ON "OAuthDeviceRefreshBinding"("familyId");

-- CreateIndex
CREATE INDEX "OAuthDeviceRefreshBinding_userId_clientId_idx" ON "OAuthDeviceRefreshBinding"("userId", "clientId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Previous migration: packages/db/prisma/migrations/0002_seed_weldall_cli/migration.sql
-- The native CLI is a fixed first-party public client. It has no client secret.
INSERT INTO "OauthClient" (
  "id",
  "clientId",
  "disabled",
  "skipConsent",
  "scopes",
  "name",
  "redirectUris",
  "tokenEndpointAuthMethod",
  "grantTypes",
  "responseTypes",
  "public",
  "type",
  "requirePKCE",
  "dpopBoundAccessTokens",
  "createdAt",
  "updatedAt"
) VALUES (
  'weldall-cli',
  'weldall-cli',
  false,
  true,
  ARRAY['openid', 'offline_access', 'weldall:scopes']::TEXT[],
  'Weldall CLI',
  ARRAY['http://127.0.0.1/callback']::TEXT[],
  'none',
  ARRAY['authorization_code', 'refresh_token']::TEXT[],
  ARRAY['code']::TEXT[],
  true,
  'native',
  true,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

-- Previous migration: packages/db/prisma/migrations/0003_seed_weldall_resource/migration.sql
-- Keep the fixed Weldall API resource available before the first auth request.
-- The runtime config fills the environment-specific signing key id.
INSERT INTO "OauthResource" (
  "id",
  "identifier",
  "name",
  "signingAlgorithm",
  "allowedScopes",
  "dpopBoundAccessTokensRequired",
  "disabled",
  "policyVersion",
  "createdAt",
  "updatedAt"
) VALUES (
  'weldall-api',
  'https://weldall.seibert.localdev/api',
  'Weldall API',
  'ES256',
  ARRAY['openid', 'offline_access', 'weldall:scopes']::TEXT[],
  true,
  false,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("identifier") DO UPDATE SET
  "name" = EXCLUDED."name",
  "signingAlgorithm" = EXCLUDED."signingAlgorithm",
  "allowedScopes" = EXCLUDED."allowedScopes",
  "dpopBoundAccessTokensRequired" = EXCLUDED."dpopBoundAccessTokensRequired",
  "disabled" = false,
  "updatedAt" = CURRENT_TIMESTAMP;

-- Previous migration: packages/db/prisma/migrations/0004_better_auth_account_identity/migration.sql
-- Better Auth 1.7 identifies external accounts by issuer and provider subject.
ALTER TABLE "Account" RENAME COLUMN "accountId" TO "providerAccountId";

ALTER TABLE "Account" ADD COLUMN "issuer" TEXT;

-- Google is the only social provider configured by Weldall.
UPDATE "Account"
SET "issuer" = 'https://accounts.google.com'
WHERE "providerId" = 'google';

ALTER TABLE "Account" ALTER COLUMN "issuer" SET NOT NULL;

CREATE UNIQUE INDEX "Account_issuer_providerAccountId_key"
ON "Account"("issuer", "providerAccountId");

-- Previous migration: packages/db/prisma/migrations/0005_admin_scope_catalog/migration.sql
-- Global scope definitions are deliberately separate from OAuth resource metadata.
CREATE TABLE "Scope" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "Scope_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Scope_key_format" CHECK (
    "key" ~ '^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$'
    AND char_length("key") <= 160
  ),
  CONSTRAINT "Scope_description_length" CHECK (
    char_length(btrim("description")) BETWEEN 1 AND 500
  ),
  CONSTRAINT "Scope_version_positive" CHECK ("version" > 0)
);

CREATE TABLE "EmailScopeAssignment" (
  "id" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "EmailScopeAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailScopeAssignment_email_normalized" CHECK (
    char_length("normalizedEmail") BETWEEN 3 AND 320
    AND "normalizedEmail" = lower(btrim("normalizedEmail"))
  ),
  CONSTRAINT "EmailScopeAssignment_version_positive" CHECK ("version" > 0)
);

CREATE TABLE "EmailScopeGrant" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT NOT NULL,

  CONSTRAINT "EmailScopeGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminAuditEvent" (
  "id" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT NOT NULL,
  "actorEmail" TEXT,
  "requestId" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminAuditEvent_schema_version_positive" CHECK ("schemaVersion" > 0),
  CONSTRAINT "AdminAuditEvent_outcome" CHECK ("outcome" IN ('success', 'denied', 'failed'))
);

CREATE UNIQUE INDEX "Scope_key_key" ON "Scope"("key");
CREATE INDEX "Scope_updatedAt_idx" ON "Scope"("updatedAt");
CREATE UNIQUE INDEX "EmailScopeAssignment_normalizedEmail_key"
  ON "EmailScopeAssignment"("normalizedEmail");
CREATE INDEX "EmailScopeAssignment_updatedAt_idx"
  ON "EmailScopeAssignment"("updatedAt");
CREATE UNIQUE INDEX "EmailScopeGrant_assignmentId_scopeId_key"
  ON "EmailScopeGrant"("assignmentId", "scopeId");
CREATE INDEX "EmailScopeGrant_scopeId_idx" ON "EmailScopeGrant"("scopeId");
CREATE INDEX "AdminAuditEvent_occurredAt_idx" ON "AdminAuditEvent"("occurredAt");
CREATE INDEX "AdminAuditEvent_eventType_occurredAt_idx"
  ON "AdminAuditEvent"("eventType", "occurredAt");
CREATE INDEX "AdminAuditEvent_actorId_occurredAt_idx"
  ON "AdminAuditEvent"("actorId", "occurredAt");
CREATE INDEX "AdminAuditEvent_subjectType_subjectId_occurredAt_idx"
  ON "AdminAuditEvent"("subjectType", "subjectId", "occurredAt");

ALTER TABLE "EmailScopeGrant"
  ADD CONSTRAINT "EmailScopeGrant_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "EmailScopeAssignment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailScopeGrant"
  ADD CONSTRAINT "EmailScopeGrant_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "Scope"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing downstream permissions become catalog entries. Creating a catalog
-- entry does not register it for a resource or grant it to anyone.
INSERT INTO "Scope" (
  "id", "key", "description", "isSystem", "version",
  "createdAt", "updatedAt", "createdBy", "updatedBy"
) VALUES
  (
    'scope-weldall-administer', 'weldall:administer',
    'Administer Weldall scopes and email assignments.', true, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  ),
  (
    'scope-expenses-read', 'expenses:read',
    'Read expenses.', false, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  ),
  (
    'scope-expenses-create', 'expenses:create',
    'Create expenses.', false, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  ),
  (
    'scope-expenses-delete', 'expenses:delete',
    'Delete expenses.', false, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  ),
  (
    'scope-expenses-write', 'expenses:write',
    'Modify expenses.', false, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  );

-- Previous migration: packages/db/prisma/migrations/0006_cli_identity_scopes/migration.sql
-- Let the native CLI request the standard OIDC claims used by `weldall status`.
UPDATE "OauthClient"
SET
  "scopes" = ARRAY['openid', 'profile', 'email', 'offline_access', 'weldall:scopes']::TEXT[],
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" = 'weldall-cli';

UPDATE "OauthResource"
SET
  "allowedScopes" = ARRAY['openid', 'profile', 'email', 'offline_access', 'weldall:scopes']::TEXT[],
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "identifier" = 'https://weldall.seibert.localdev/api';

-- Previous migration: packages/db/prisma/migrations/0007_skill_registry/migration.sql
CREATE TABLE "Skill" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "requiredScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "Skill_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Skill_slug_format" CHECK (
    "slug" ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    AND char_length("slug") <= 120
  ),
  CONSTRAINT "Skill_title_length" CHECK (
    char_length(btrim("title")) BETWEEN 1 AND 200
  ),
  CONSTRAINT "Skill_content_length" CHECK (
    char_length(btrim("content")) BETWEEN 1 AND 100000
  ),
  CONSTRAINT "Skill_required_scopes_limit" CHECK (
    cardinality("requiredScopes") <= 100
  ),
  CONSTRAINT "Skill_version_positive" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "Skill_slug_key" ON "Skill"("slug");
CREATE INDEX "Skill_updatedAt_idx" ON "Skill"("updatedAt");

-- Previous migration: packages/db/prisma/migrations/0008_cli_settings/migration.sql
CREATE TABLE "CliSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "appendix" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "CliSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CliSettings_singleton" CHECK ("id" = 'default'),
  CONSTRAINT "CliSettings_appendix_length" CHECK (char_length("appendix") <= 100000),
  CONSTRAINT "CliSettings_version_positive" CHECK ("version" > 0)
);

INSERT INTO "CliSettings" (
  "id",
  "appendix",
  "updatedAt",
  "createdBy",
  "updatedBy"
) VALUES (
  'default',
  '',
  CURRENT_TIMESTAMP,
  'migration',
  'migration'
);

-- Downstream resource registry. Better Auth's "OauthResource" remains Weldall-only.
CREATE TABLE "DownstreamResource" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "resourceIdentifier" TEXT NOT NULL,
  "authorizationServer" TEXT NOT NULL,
  "downstreamClientId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "DownstreamResource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DownstreamResource_key_format" CHECK (
    "key" ~ '^[a-z0-9._-]+$' AND char_length("key") <= 120
  ),
  CONSTRAINT "DownstreamResource_name_length" CHECK (
    char_length(btrim("name")) BETWEEN 1 AND 200
  ),
  CONSTRAINT "DownstreamResource_client_id_length" CHECK (
    char_length(btrim("downstreamClientId")) BETWEEN 1 AND 200
  ),
  CONSTRAINT "DownstreamResource_version_positive" CHECK ("version" > 0)
);

CREATE TABLE "ResourceScope" (
  "resourceId" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  CONSTRAINT "ResourceScope_pkey" PRIMARY KEY ("resourceId", "scopeId")
);

CREATE TABLE "ResourceRequestPrefix" (
  "id" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "urlPrefix" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT NOT NULL,
  CONSTRAINT "ResourceRequestPrefix_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DownstreamResource_key_key" ON "DownstreamResource"("key");
CREATE UNIQUE INDEX "DownstreamResource_resourceIdentifier_key" ON "DownstreamResource"("resourceIdentifier");
CREATE INDEX "DownstreamResource_name_idx" ON "DownstreamResource"("name");
CREATE INDEX "DownstreamResource_updatedAt_idx" ON "DownstreamResource"("updatedAt");
CREATE INDEX "DownstreamResource_enabled_idx" ON "DownstreamResource"("enabled");
CREATE INDEX "ResourceScope_scopeId_idx" ON "ResourceScope"("scopeId");
CREATE UNIQUE INDEX "ResourceRequestPrefix_urlPrefix_key" ON "ResourceRequestPrefix"("urlPrefix");
CREATE INDEX "ResourceRequestPrefix_resourceId_idx" ON "ResourceRequestPrefix"("resourceId");

ALTER TABLE "ResourceScope" ADD CONSTRAINT "ResourceScope_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceScope" ADD CONSTRAINT "ResourceScope_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResourceRequestPrefix" ADD CONSTRAINT "ResourceRequestPrefix_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "DownstreamResource" (
  "id", "key", "name", "resourceIdentifier", "authorizationServer", "downstreamClientId",
  "enabled", "version", "createdAt", "updatedAt", "createdBy", "updatedBy"
) VALUES (
  'downstream-resource-expenses', 'expenses', 'Expenses',
  'https://expenses.seibert.localdev/api', 'https://expenses.seibert.localdev',
  'weldall-cli-at-expenses', true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
);

INSERT INTO "ResourceRequestPrefix" (
  "id", "resourceId", "urlPrefix", "createdAt", "createdBy"
) VALUES (
  'resource-prefix-expenses-api', 'downstream-resource-expenses',
  'https://expenses.seibert.localdev/api', CURRENT_TIMESTAMP, 'migration'
);

INSERT INTO "ResourceScope" ("resourceId", "scopeId")
SELECT 'downstream-resource-expenses', "id"
FROM "Scope"
WHERE "key" IN ('expenses:read', 'expenses:create', 'expenses:delete', 'expenses:write');
