-- Shared, cross-process replay protection for OAuth assertions and DPoP proofs.
CREATE TABLE "ReplayMarker" (
  "key" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplayMarker_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "ReplayMarker_expiresAt_idx" ON "ReplayMarker"("expiresAt");
