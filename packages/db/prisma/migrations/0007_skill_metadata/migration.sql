ALTER TABLE "Skill"
ADD COLUMN "meta" JSONB,
ADD COLUMN "lastUpdatedAt" TEXT;

ALTER TABLE "DiscoveredSkill"
ADD COLUMN "meta" JSONB,
ADD COLUMN "lastUpdatedAt" TEXT;
