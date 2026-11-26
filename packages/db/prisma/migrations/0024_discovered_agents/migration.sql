-- Agent discovery: a resource an administrator allowed to (agentDiscoveryEnabled) publishes the
-- agents people shared through it; Weldall copies them with the resource's skill catalog. The agent
-- side of a refresh keeps its own freshness and failure, so it never takes the skills offline.
ALTER TABLE "DownstreamResource" ADD COLUMN "agentDiscoveryEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "agentApiEndpoint" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "agentApiScope" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "agentsSourceResourceVersion" INTEGER;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "agentsLastSuccessfulRefreshAt" TIMESTAMP(3);
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "agentsStaleAfter" TIMESTAMP(3);
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "agentsLastFailureCategory" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "agentsLastFailureAt" TIMESTAMP(3);
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "agentsSkippedCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "DiscoveredAgent" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "canonicalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "configFormat" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "revision" INTEGER NOT NULL,
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredAgent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscoveredAgent_canonicalId_key" ON "DiscoveredAgent"("canonicalId");
CREATE UNIQUE INDEX "DiscoveredAgent_catalogId_localId_key" ON "DiscoveredAgent"("catalogId", "localId");
CREATE INDEX "DiscoveredAgent_catalogId_idx" ON "DiscoveredAgent"("catalogId");
CREATE INDEX "DiscoveredAgent_ownerId_idx" ON "DiscoveredAgent"("ownerId");

ALTER TABLE "DiscoveredAgent" ADD CONSTRAINT "DiscoveredAgent_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "DiscoveredSkillCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
