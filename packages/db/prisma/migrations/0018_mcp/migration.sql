ALTER TABLE "Skill" ADD COLUMN "mcpDependencies" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "DiscoveredSkill" ADD COLUMN "mcpDependencies" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "ConnectorRegistration" (
  "connectorId" TEXT NOT NULL PRIMARY KEY,
  "status" TEXT NOT NULL,
  "binding" TEXT NOT NULL,
  "clientId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectorRegistration_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorRegistration_state_check" CHECK (
    ("status" IN ('REGISTERING', 'FAILED') AND "clientId" IS NULL) OR
    ("status" = 'READY' AND "clientId" IS NOT NULL)
  )
);

