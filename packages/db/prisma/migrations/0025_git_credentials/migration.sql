-- CreateEnum
CREATE TYPE "GitCredentialAccess" AS ENUM ('READ', 'WRITE');

-- CreateTable
CREATE TABLE "GitCredential" (
    "id" TEXT NOT NULL,
    "secretHash" BYTEA NOT NULL,
    "userId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "access" "GitCredentialAccess" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitCredential_userId_createdAt_idx" ON "GitCredential"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GitCredential_appId_idx" ON "GitCredential"("appId");

-- CreateIndex
CREATE INDEX "GitCredential_expiresAt_idx" ON "GitCredential"("expiresAt");

-- AddForeignKey
ALTER TABLE "GitCredential" ADD CONSTRAINT "GitCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitCredential" ADD CONSTRAINT "GitCredential_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

