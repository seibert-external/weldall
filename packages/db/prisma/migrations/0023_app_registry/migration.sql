-- CreateTable
CREATE TABLE "App" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "repositoryOwner" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "repositoryId" TEXT,
    "defaultBranch" TEXT NOT NULL,
    "template" TEXT,
    "templateCommit" TEXT,
    "previewUrl" TEXT,
    "liveUrl" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "App_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "App_ownerId_createdAt_idx" ON "App"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "App_expiresAt_id_idx" ON "App"("expiresAt", "id");

-- CreateIndex
CREATE INDEX "App_createdAt_id_idx" ON "App"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "App_connectorId_repositoryOwner_repositoryName_key" ON "App"("connectorId", "repositoryOwner", "repositoryName");

-- CreateIndex
CREATE UNIQUE INDEX "App_connectorId_repositoryId_key" ON "App"("connectorId", "repositoryId");

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "App" ADD CONSTRAINT "App_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

