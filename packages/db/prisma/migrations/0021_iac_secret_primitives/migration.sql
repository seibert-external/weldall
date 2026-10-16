ALTER TYPE "IacPrimitiveKind" ADD VALUE 'SHARED_CONNECTION';
ALTER TYPE "IacPrimitiveKind" ADD VALUE 'GROUP_PROVIDER';
ALTER TYPE "IacPrimitiveKind" ADD VALUE 'LOGIN_PROVIDER';

ALTER TABLE "Connection" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
-- DISABLED was an explicit administrative state, never a credential failure.
UPDATE "Connection" SET "enabled" = false, "status" = 'READY' WHERE "status" = 'DISABLED';
ALTER TABLE "GroupProvider" ALTER COLUMN "encryptedToken" DROP NOT NULL;
ALTER TABLE "LoginProvider" ALTER COLUMN "encryptedClientSecret" DROP NOT NULL,
  ALTER COLUMN "validatedAt" DROP NOT NULL;

ALTER TABLE "IacObjectBinding" ADD COLUMN "sharedConnectionId" TEXT,
  ADD COLUMN "groupProviderId" TEXT, ADD COLUMN "loginProviderId" TEXT;
CREATE UNIQUE INDEX "IacObjectBinding_sharedConnectionId_key" ON "IacObjectBinding"("sharedConnectionId");
CREATE UNIQUE INDEX "IacObjectBinding_groupProviderId_key" ON "IacObjectBinding"("groupProviderId");
CREATE UNIQUE INDEX "IacObjectBinding_loginProviderId_key" ON "IacObjectBinding"("loginProviderId");
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_sharedConnectionId_fkey"
  FOREIGN KEY ("sharedConnectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_groupProviderId_fkey"
  FOREIGN KEY ("groupProviderId") REFERENCES "GroupProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_loginProviderId_fkey"
  FOREIGN KEY ("loginProviderId") REFERENCES "LoginProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IacObjectBinding" DROP CONSTRAINT "IacObjectBinding_kind_target_check";
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_kind_target_check" CHECK (
  num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId", "skillId", "connectorId", "sharedConnectionId", "groupProviderId", "loginProviderId") = 0
  OR (
    num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId", "skillId", "connectorId", "sharedConnectionId", "groupProviderId", "loginProviderId") = 1
    AND (
      ("kind"::text = 'SCOPE' AND "scopeId" IS NOT NULL)
      OR ("kind"::text = 'RESOURCE' AND "resourceId" IS NOT NULL)
      OR ("kind"::text = 'MACHINE' AND "machineClientId" IS NOT NULL)
      OR ("kind"::text = 'EMAIL_ASSIGNMENT' AND "emailAssignmentId" IS NOT NULL)
      OR ("kind"::text = 'GROUP_ASSIGNMENT' AND "groupAssignmentId" IS NOT NULL)
      OR ("kind"::text = 'SKILL' AND "skillId" IS NOT NULL)
      OR ("kind"::text = 'CONNECTOR' AND "connectorId" IS NOT NULL)
      OR ("kind"::text = 'SHARED_CONNECTION' AND "sharedConnectionId" IS NOT NULL)
      OR ("kind"::text = 'GROUP_PROVIDER' AND "groupProviderId" IS NOT NULL)
      OR ("kind"::text = 'LOGIN_PROVIDER' AND "loginProviderId" IS NOT NULL)
    )
  )
);
