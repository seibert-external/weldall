-- Shared agents a resource publishes through agent discovery, copied with its skill catalog.
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
