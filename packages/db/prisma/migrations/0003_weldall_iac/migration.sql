-- Native Weldall YAML IaC ownership and idempotency foundation.
CREATE TYPE "IacPrimitiveKind" AS ENUM ('SCOPE', 'RESOURCE', 'MACHINE', 'EMAIL_ASSIGNMENT', 'GROUP_ASSIGNMENT');
CREATE TYPE "IacOperationType" AS ENUM ('APPLY', 'IMPORT', 'UNMANAGE', 'STATE_MOVE');
CREATE TYPE "IacOperationStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');

CREATE TABLE "IacInstallation" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "installationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IacInstallation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IacInstallation_installationId_key" ON "IacInstallation"("installationId");

CREATE TABLE "IacWorkspace" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "lastConfigDigest" TEXT,
  "lastActorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IacWorkspace_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IacWorkspace_updatedAt_idx" ON "IacWorkspace"("updatedAt");

CREATE TABLE "IacObjectBinding" (
  "id" TEXT NOT NULL,
  "workspaceId" UUID NOT NULL,
  "address" TEXT NOT NULL,
  "kind" "IacPrimitiveKind" NOT NULL,
  "naturalIdentity" TEXT NOT NULL,
  "scopeId" TEXT,
  "resourceId" TEXT,
  "machineClientId" TEXT,
  "emailAssignmentId" TEXT,
  "groupAssignmentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IacObjectBinding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IacObjectBinding_workspaceId_address_key" ON "IacObjectBinding"("workspaceId", "address");
CREATE UNIQUE INDEX "IacObjectBinding_scopeId_key" ON "IacObjectBinding"("scopeId");
CREATE UNIQUE INDEX "IacObjectBinding_resourceId_key" ON "IacObjectBinding"("resourceId");
CREATE UNIQUE INDEX "IacObjectBinding_machineClientId_key" ON "IacObjectBinding"("machineClientId");
CREATE UNIQUE INDEX "IacObjectBinding_emailAssignmentId_key" ON "IacObjectBinding"("emailAssignmentId");
CREATE UNIQUE INDEX "IacObjectBinding_groupAssignmentId_key" ON "IacObjectBinding"("groupAssignmentId");
CREATE INDEX "IacObjectBinding_workspaceId_kind_idx" ON "IacObjectBinding"("workspaceId", "kind");
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "IacWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "DownstreamResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_machineClientId_fkey" FOREIGN KEY ("machineClientId") REFERENCES "MachineClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_emailAssignmentId_fkey" FOREIGN KEY ("emailAssignmentId") REFERENCES "EmailScopeAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_groupAssignmentId_fkey" FOREIGN KEY ("groupAssignmentId") REFERENCES "GroupScopeAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IacObjectBinding" ADD CONSTRAINT "IacObjectBinding_one_target_check" CHECK (num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId") <= 1);

CREATE TABLE "IacOperation" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "type" "IacOperationType" NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "priorRevision" INTEGER NOT NULL,
  "resultingRevision" INTEGER,
  "status" "IacOperationStatus" NOT NULL DEFAULT 'STARTED',
  "resultSummary" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IacOperation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IacOperation_workspaceId_createdAt_idx" ON "IacOperation"("workspaceId", "createdAt");
ALTER TABLE "IacOperation" ADD CONSTRAINT "IacOperation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "IacWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "IacInstallation" ("id", "installationId") VALUES ('default', gen_random_uuid());
