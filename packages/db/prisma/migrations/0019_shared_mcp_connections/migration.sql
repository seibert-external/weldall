BEGIN;

CREATE TYPE "ConnectionAccessMode" AS ENUM ('OWNER_ONLY', 'SCOPED');
ALTER TABLE "Connection"
  ADD COLUMN "key" TEXT,
  ADD COLUMN "accessMode" "ConnectionAccessMode" NOT NULL DEFAULT 'OWNER_ONLY',
  ADD CONSTRAINT "Connection_access_key_check" CHECK (
    ("accessMode" = 'OWNER_ONLY' AND "key" IS NULL) OR
    ("accessMode" = 'SCOPED' AND "key" IS NOT NULL AND "key" ~ '^[a-z0-9][a-z0-9._-]{0,119}$')
  );
CREATE UNIQUE INDEX "Connection_key_key" ON "Connection"("key");
DROP INDEX "Connection_ownerId_name_key";
CREATE INDEX "Connection_ownerId_name_idx" ON "Connection"("ownerId", "name");
CREATE UNIQUE INDEX "Connection_personal_name_key" ON "Connection"("ownerId", "name") WHERE "accessMode" = 'OWNER_ONLY';
CREATE TABLE "ConnectionUseScope" (
  "connectionId" TEXT NOT NULL REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "scopeId" TEXT NOT NULL REFERENCES "Scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY ("connectionId", "scopeId")
);
CREATE INDEX "ConnectionUseScope_scopeId_idx" ON "ConnectionUseScope"("scopeId");

COMMIT;
