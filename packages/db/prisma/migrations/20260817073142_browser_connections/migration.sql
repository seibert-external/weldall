-- CreateEnum
CREATE TYPE "BrowserConnectionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'ISSUING', 'CONSUMED');

-- CreateEnum
CREATE TYPE "BrowserConnectionIssuanceStatus" AS ENUM ('CLAIMED', 'PROVIDER_ISSUED', 'BINDING_CREATED', 'COMMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "BrowserConnectionState" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "OAuthDeviceRefreshBinding" ADD COLUMN     "browserConnectionId" TEXT;

-- CreateTable
CREATE TABLE "BrowserConnectionRequest" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCodeHash" TEXT NOT NULL,
    "browserClientId" TEXT NOT NULL,
    "oauthClientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "dpopJkt" TEXT NOT NULL,
    "status" "BrowserConnectionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 5,
    "lastPolledAt" TIMESTAMP(3),
    "issuanceAttemptId" TEXT,
    "issuanceClaimedAt" TIMESTAMP(3),
    "connectionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "decidedByUserId" TEXT,
    "deniedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserConnectionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserConnectionIssuanceAttempt" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" "BrowserConnectionIssuanceStatus" NOT NULL DEFAULT 'CLAIMED',
    "providerAccessTokenHash" TEXT,
    "providerRefreshTokenHash" TEXT,
    "refreshFamilyId" TEXT,
    "connectionId" TEXT,
    "failureCode" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerIssuedAt" TIMESTAMP(3),
    "bindingCreatedAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserConnectionIssuanceAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserConnection" (
    "id" TEXT NOT NULL,
    "browserClientId" TEXT NOT NULL,
    "oauthClientId" TEXT,
    "resourceId" TEXT,
    "resourceKey" TEXT NOT NULL,
    "resourceIdentifier" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userReferenceId" TEXT,
    "dpopJkt" TEXT NOT NULL,
    "refreshFamilyId" TEXT NOT NULL,
    "approvedVia" TEXT NOT NULL,
    "state" "BrowserConnectionState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revocationReason" TEXT,

    CONSTRAINT "BrowserConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserConnectionRateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserConnectionRateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionRequest_deviceCodeHash_key" ON "BrowserConnectionRequest"("deviceCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionRequest_userCodeHash_key" ON "BrowserConnectionRequest"("userCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionRequest_issuanceAttemptId_key" ON "BrowserConnectionRequest"("issuanceAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionRequest_connectionId_key" ON "BrowserConnectionRequest"("connectionId");

-- CreateIndex
CREATE INDEX "BrowserConnectionRequest_status_expiresAt_idx" ON "BrowserConnectionRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BrowserConnectionRequest_resourceId_status_expiresAt_idx" ON "BrowserConnectionRequest"("resourceId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "BrowserConnectionRequest_browserClientId_status_expiresAt_idx" ON "BrowserConnectionRequest"("browserClientId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "BrowserConnectionRequest_origin_status_expiresAt_idx" ON "BrowserConnectionRequest"("origin", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionIssuanceAttempt_requestId_key" ON "BrowserConnectionIssuanceAttempt"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionIssuanceAttempt_providerAccessTokenHash_key" ON "BrowserConnectionIssuanceAttempt"("providerAccessTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionIssuanceAttempt_providerRefreshTokenHash_key" ON "BrowserConnectionIssuanceAttempt"("providerRefreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionIssuanceAttempt_refreshFamilyId_key" ON "BrowserConnectionIssuanceAttempt"("refreshFamilyId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnectionIssuanceAttempt_connectionId_key" ON "BrowserConnectionIssuanceAttempt"("connectionId");

-- CreateIndex
CREATE INDEX "BrowserConnectionIssuanceAttempt_status_updatedAt_idx" ON "BrowserConnectionIssuanceAttempt"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserConnection_refreshFamilyId_key" ON "BrowserConnection"("refreshFamilyId");

-- CreateIndex
CREATE INDEX "BrowserConnection_userId_state_idx" ON "BrowserConnection"("userId", "state");

-- CreateIndex
CREATE INDEX "BrowserConnection_resourceId_state_idx" ON "BrowserConnection"("resourceId", "state");

-- CreateIndex
CREATE INDEX "BrowserConnection_resourceKey_state_idx" ON "BrowserConnection"("resourceKey", "state");

-- CreateIndex
CREATE INDEX "BrowserConnection_origin_state_idx" ON "BrowserConnection"("origin", "state");

-- CreateIndex
CREATE INDEX "BrowserConnection_browserClientId_state_idx" ON "BrowserConnection"("browserClientId", "state");

-- CreateIndex
CREATE INDEX "BrowserConnectionRateLimitBucket_expiresAt_idx" ON "BrowserConnectionRateLimitBucket"("expiresAt");

-- CreateIndex
CREATE INDEX "OAuthDeviceRefreshBinding_browserConnectionId_idx" ON "OAuthDeviceRefreshBinding"("browserConnectionId");

-- AddForeignKey
ALTER TABLE "BrowserConnectionRequest" ADD CONSTRAINT "BrowserConnectionRequest_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "OauthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnectionRequest" ADD CONSTRAINT "BrowserConnectionRequest_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnectionRequest" ADD CONSTRAINT "BrowserConnectionRequest_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnectionRequest" ADD CONSTRAINT "BrowserConnectionRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnectionRequest" ADD CONSTRAINT "BrowserConnectionRequest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BrowserConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnectionIssuanceAttempt" ADD CONSTRAINT "BrowserConnectionIssuanceAttempt_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BrowserConnectionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnectionIssuanceAttempt" ADD CONSTRAINT "BrowserConnectionIssuanceAttempt_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BrowserConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnection" ADD CONSTRAINT "BrowserConnection_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "OauthClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnection" ADD CONSTRAINT "BrowserConnection_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserConnection" ADD CONSTRAINT "BrowserConnection_userReferenceId_fkey" FOREIGN KEY ("userReferenceId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthDeviceRefreshBinding" ADD CONSTRAINT "OAuthDeviceRefreshBinding_browserConnectionId_fkey" FOREIGN KEY ("browserConnectionId") REFERENCES "BrowserConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
