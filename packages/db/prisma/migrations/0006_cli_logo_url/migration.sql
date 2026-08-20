ALTER TABLE "CliSettings"
  ADD COLUMN "logoUrl" TEXT;

UPDATE "CliSettings"
SET "logoUrl" = '';

ALTER TABLE "CliSettings"
  ALTER COLUMN "logoUrl" SET NOT NULL;
