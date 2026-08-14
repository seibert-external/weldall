-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SkillVisibility" AS ENUM ('DEFAULT', 'HIDDEN_IF_UNALLOWED');

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

    CONSTRAINT "Scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailScopeAssignment" (
    "id" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "EmailScopeAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailScopeGrant" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "EmailScopeGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

    CONSTRAINT "GroupProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupScopeAssignment" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "GroupScopeAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupScopeGrant" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "GroupScopeGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "requiredScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "SkillVisibility" NOT NULL DEFAULT 'DEFAULT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CliSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "appendix" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "CliSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownstreamResource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resourceIdentifier" TEXT NOT NULL,
    "authorizationServer" TEXT NOT NULL,
    "downstreamClientId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "skillDiscoveryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "DownstreamResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredSkillCatalog" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "sourceResourceVersion" INTEGER,
    "schemaVersion" INTEGER,
    "metadataUrl" TEXT,
    "catalogEndpoint" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessfulRefreshAt" TIMESTAMP(3),
    "nextRefreshAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staleAfter" TIMESTAMP(3),
    "refreshLeaseId" TEXT,
    "refreshLeaseUntil" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureCategory" TEXT,
    "lastFailureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredSkillCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredSkill" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "canonicalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "requiredScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "SkillVisibility" NOT NULL DEFAULT 'DEFAULT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceScope" (
    "resourceId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,

    CONSTRAINT "ResourceScope_pkey" PRIMARY KEY ("resourceId","scopeId")
);

-- CreateTable
CREATE TABLE "ResourceRequestPrefix" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "urlPrefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ResourceRequestPrefix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorEmail" TEXT,
    "clientId" TEXT,
    "requestId" TEXT NOT NULL,
    "correlationId" TEXT,
    "deduplicationKey" TEXT,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
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
    "issuer" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
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
CREATE UNIQUE INDEX "Scope_key_key" ON "Scope"("key");

-- CreateIndex
CREATE INDEX "Scope_updatedAt_idx" ON "Scope"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailScopeAssignment_normalizedEmail_key" ON "EmailScopeAssignment"("normalizedEmail");

-- CreateIndex
CREATE INDEX "EmailScopeAssignment_updatedAt_idx" ON "EmailScopeAssignment"("updatedAt");

-- CreateIndex
CREATE INDEX "EmailScopeGrant_scopeId_idx" ON "EmailScopeGrant"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailScopeGrant_assignmentId_scopeId_key" ON "EmailScopeGrant"("assignmentId", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupProvider_key_key" ON "GroupProvider"("key");

-- CreateIndex
CREATE INDEX "GroupProvider_enabled_idx" ON "GroupProvider"("enabled");

-- CreateIndex
CREATE INDEX "GroupProvider_updatedAt_idx" ON "GroupProvider"("updatedAt");

-- CreateIndex
CREATE INDEX "GroupScopeAssignment_updatedAt_idx" ON "GroupScopeAssignment"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GroupScopeAssignment_providerId_groupId_key" ON "GroupScopeAssignment"("providerId", "groupId");

-- CreateIndex
CREATE INDEX "GroupScopeGrant_scopeId_idx" ON "GroupScopeGrant"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupScopeGrant_assignmentId_scopeId_key" ON "GroupScopeGrant"("assignmentId", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_slug_key" ON "Skill"("slug");

-- CreateIndex
CREATE INDEX "Skill_updatedAt_idx" ON "Skill"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DownstreamResource_key_key" ON "DownstreamResource"("key");

-- CreateIndex
CREATE UNIQUE INDEX "DownstreamResource_resourceIdentifier_key" ON "DownstreamResource"("resourceIdentifier");

-- CreateIndex
CREATE INDEX "DownstreamResource_name_idx" ON "DownstreamResource"("name");

-- CreateIndex
CREATE INDEX "DownstreamResource_updatedAt_idx" ON "DownstreamResource"("updatedAt");

-- CreateIndex
CREATE INDEX "DownstreamResource_enabled_idx" ON "DownstreamResource"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredSkillCatalog_resourceId_key" ON "DiscoveredSkillCatalog"("resourceId");

-- CreateIndex
CREATE INDEX "DiscoveredSkillCatalog_nextRefreshAt_refreshLeaseUntil_idx" ON "DiscoveredSkillCatalog"("nextRefreshAt", "refreshLeaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredSkill_canonicalId_key" ON "DiscoveredSkill"("canonicalId");

-- CreateIndex
CREATE INDEX "DiscoveredSkill_catalogId_idx" ON "DiscoveredSkill"("catalogId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredSkill_catalogId_localId_key" ON "DiscoveredSkill"("catalogId", "localId");

-- CreateIndex
CREATE INDEX "ResourceScope_scopeId_idx" ON "ResourceScope"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceRequestPrefix_urlPrefix_key" ON "ResourceRequestPrefix"("urlPrefix");

-- CreateIndex
CREATE INDEX "ResourceRequestPrefix_resourceId_idx" ON "ResourceRequestPrefix"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_deduplicationKey_key" ON "AuditEvent"("deduplicationKey");

-- CreateIndex
CREATE INDEX "AuditEvent_occurredAt_id_idx" ON "AuditEvent"("occurredAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_occurredAt_id_idx" ON "AuditEvent"("eventType", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_occurredAt_id_idx" ON "AuditEvent"("actorId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_actorEmail_occurredAt_id_idx" ON "AuditEvent"("actorEmail", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_subjectType_subjectId_occurredAt_id_idx" ON "AuditEvent"("subjectType", "subjectId", "occurredAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_issuer_providerAccountId_key" ON "Account"("issuer", "providerAccountId");

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
ALTER TABLE "EmailScopeGrant" ADD CONSTRAINT "EmailScopeGrant_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "EmailScopeAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailScopeGrant" ADD CONSTRAINT "EmailScopeGrant_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupScopeAssignment" ADD CONSTRAINT "GroupScopeAssignment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "GroupProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupScopeGrant" ADD CONSTRAINT "GroupScopeGrant_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "GroupScopeAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupScopeGrant" ADD CONSTRAINT "GroupScopeGrant_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredSkillCatalog" ADD CONSTRAINT "DiscoveredSkillCatalog_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredSkill" ADD CONSTRAINT "DiscoveredSkill_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "DiscoveredSkillCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceScope" ADD CONSTRAINT "ResourceScope_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceScope" ADD CONSTRAINT "ResourceScope_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceRequestPrefix" ADD CONSTRAINT "ResourceRequestPrefix_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Application invariants not expressible in Prisma's schema language.
ALTER TABLE "Scope"
  ADD CONSTRAINT "Scope_key_format" CHECK (
    "key" ~ '^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$' AND char_length("key") <= 160
  ),
  ADD CONSTRAINT "Scope_description_length" CHECK (
    char_length(btrim("description")) BETWEEN 1 AND 500
  ),
  ADD CONSTRAINT "Scope_version_positive" CHECK ("version" > 0);

ALTER TABLE "EmailScopeAssignment"
  ADD CONSTRAINT "EmailScopeAssignment_email_normalized" CHECK (
    char_length("normalizedEmail") BETWEEN 3 AND 320
    AND "normalizedEmail" = lower(btrim("normalizedEmail"))
  ),
  ADD CONSTRAINT "EmailScopeAssignment_version_positive" CHECK ("version" > 0);

ALTER TABLE "Skill"
  ADD CONSTRAINT "Skill_slug_format" CHECK (
    "slug" ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$' AND char_length("slug") <= 120
  ),
  ADD CONSTRAINT "Skill_title_length" CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "Skill_content_length" CHECK (char_length(btrim("content")) BETWEEN 1 AND 100000),
  ADD CONSTRAINT "Skill_required_scopes_limit" CHECK (cardinality("requiredScopes") <= 100),
  ADD CONSTRAINT "Skill_version_positive" CHECK ("version" > 0);

ALTER TABLE "CliSettings"
  ADD CONSTRAINT "CliSettings_singleton" CHECK ("id" = 'default'),
  ADD CONSTRAINT "CliSettings_appendix_length" CHECK (char_length("appendix") <= 100000),
  ADD CONSTRAINT "CliSettings_version_positive" CHECK ("version" > 0);

ALTER TABLE "DownstreamResource"
  ADD CONSTRAINT "DownstreamResource_key_format" CHECK (
    "key" ~ '^[a-z0-9._-]+$' AND char_length("key") <= 120
  ),
  ADD CONSTRAINT "DownstreamResource_name_length" CHECK (
    char_length(btrim("name")) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT "DownstreamResource_client_id_length" CHECK (
    char_length(btrim("downstreamClientId")) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT "DownstreamResource_version_positive" CHECK ("version" > 0);

ALTER TABLE "DiscoveredSkillCatalog"
  ADD CONSTRAINT "DiscoveredSkillCatalog_retry_count" CHECK ("retryCount" >= 0),
  ADD CONSTRAINT "DiscoveredSkillCatalog_schema_version" CHECK (
    "schemaVersion" IS NULL OR "schemaVersion" = 1
  );

ALTER TABLE "DiscoveredSkill"
  ADD CONSTRAINT "DiscoveredSkill_local_id" CHECK (
    "localId" ~ '^[a-z0-9]+(?:[_-][a-z0-9]+)*$' AND char_length("localId") <= 120
  ),
  ADD CONSTRAINT "DiscoveredSkill_canonical_id" CHECK (
    char_length("canonicalId") BETWEEN 3 AND 241
  ),
  ADD CONSTRAINT "DiscoveredSkill_title_length" CHECK (
    char_length(btrim("title")) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT "DiscoveredSkill_content_length" CHECK (
    char_length(btrim("content")) BETWEEN 1 AND 100000
  ),
  ADD CONSTRAINT "DiscoveredSkill_required_scopes_limit" CHECK (
    cardinality("requiredScopes") <= 100
  );

ALTER TABLE "GroupProvider"
  ADD CONSTRAINT "GroupProvider_key_format" CHECK (
    "key" ~ '^[a-z0-9][a-z0-9._-]*$' AND char_length("key") <= 120
  ),
  ADD CONSTRAINT "GroupProvider_name_length" CHECK (
    char_length(btrim("name")) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT "GroupProvider_adapter_type" CHECK ("adapterType" IN ('management-api-v1')),
  ADD CONSTRAINT "GroupProvider_base_url_length" CHECK (
    char_length("baseUrl") BETWEEN 1 AND 2000
  ),
  ADD CONSTRAINT "GroupProvider_encrypted_token_present" CHECK (char_length("encryptedToken") > 0),
  ADD CONSTRAINT "GroupProvider_version" CHECK ("version" > 0),
  ADD CONSTRAINT "GroupProvider_encryption_key_version" CHECK ("encryptionKeyVersion" > 0);

ALTER TABLE "GroupScopeAssignment"
  ADD CONSTRAINT "GroupScopeAssignment_group_id_length" CHECK (
    char_length(btrim("groupId")) BETWEEN 1 AND 191
  ),
  ADD CONSTRAINT "GroupScopeAssignment_version" CHECK ("version" > 0);

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_schema_version_positive" CHECK ("schemaVersion" > 0),
  ADD CONSTRAINT "AuditEvent_actor_type" CHECK (
    "actorType" IN ('user', 'oauth_client', 'workload', 'anonymous')
  ),
  ADD CONSTRAINT "AuditEvent_event_type" CHECK (
    "eventType" IN (
      'id_jag.issued', 'id_jag.denied', 'id_jag.failed',
      'user_scopes.created', 'user_scopes.replaced', 'user_scopes.deleted',
      'resource_scopes.created', 'resource_scopes.replaced', 'resource_scopes.deleted',
      'cli_settings.updated', 'skill.created', 'skill.updated', 'skill.deleted',
      'group_provider.created', 'group_provider.updated', 'group_provider.deleted',
      'group_provider.tested', 'group_scopes.created', 'group_scopes.replaced',
      'group_scopes.deleted'
    )
  ) NOT VALID,
  ADD CONSTRAINT "AuditEvent_request_id" CHECK ("requestId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT "AuditEvent_correlation_id" CHECK (
    "correlationId" IS NULL OR "correlationId" ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  ADD CONSTRAINT "AuditEvent_outcome" CHECK ("outcome" IN ('success', 'denied', 'failed')),
  ADD CONSTRAINT "AuditEvent_outcome_reason" CHECK (
    ("outcome" = 'success' AND "reasonCode" IS NULL)
    OR ("outcome" IN ('denied', 'failed') AND "reasonCode" IS NOT NULL)
  ),
  ADD CONSTRAINT "AuditEvent_reason_code" CHECK (
    "reasonCode" IS NULL OR "reasonCode" IN (
      'invalid_client', 'invalid_resource', 'scope_not_granted',
      'invalid_dpop_proof', 'replay_detected', 'invalid_grant',
      'invalid_request', 'internal_error', 'audit_store_unavailable'
    )
  ),
  ADD CONSTRAINT "AuditEvent_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
  ADD CONSTRAINT "AuditEvent_subject_pair" CHECK (("subjectType" IS NULL) = ("subjectId" IS NULL));
