ALTER TABLE "BrowserConnection" ADD COLUMN "providerReferenceId" TEXT;

UPDATE "BrowserConnection" AS connection
SET "providerReferenceId" = COALESCE(
  (
    SELECT request."id"
    FROM "BrowserConnectionRequest" AS request
    WHERE request."connectionId" = connection."id"
    LIMIT 1
  ),
  'legacy:' || connection."id"
);

ALTER TABLE "BrowserConnection" ALTER COLUMN "providerReferenceId" SET NOT NULL;
CREATE UNIQUE INDEX "BrowserConnection_providerReferenceId_key"
  ON "BrowserConnection"("providerReferenceId");
