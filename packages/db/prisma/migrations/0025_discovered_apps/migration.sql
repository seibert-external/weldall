-- App discovery: a resource an administrator allowed to (appDiscoveryEnabled) publishes the apps
-- it found (for example repositories with a marker file in a Git host); Weldall copies them with
-- the resource's skill catalog. The app side of a refresh keeps its own freshness and failure, so it
-- never takes the skills or the agents offline.
ALTER TABLE "DownstreamResource" ADD COLUMN "appDiscoveryEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appsSourceResourceVersion" INTEGER;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appsLastSuccessfulRefreshAt" TIMESTAMP(3);
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appsStaleAfter" TIMESTAMP(3);
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appsLastFailureCategory" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appsLastFailureAt" TIMESTAMP(3);
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appsSkippedCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "DiscoveredApp" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "canonicalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ownerId" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "repositoryName" TEXT,
    "repositoryUrl" TEXT,
    "url" TEXT,
    "revision" INTEGER NOT NULL,
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredApp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscoveredApp_canonicalId_key" ON "DiscoveredApp"("canonicalId");
CREATE UNIQUE INDEX "DiscoveredApp_catalogId_localId_key" ON "DiscoveredApp"("catalogId", "localId");
CREATE INDEX "DiscoveredApp_catalogId_idx" ON "DiscoveredApp"("catalogId");
CREATE INDEX "DiscoveredApp_ownerId_idx" ON "DiscoveredApp"("ownerId");

ALTER TABLE "DiscoveredApp" ADD CONSTRAINT "DiscoveredApp_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "DiscoveredSkillCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
