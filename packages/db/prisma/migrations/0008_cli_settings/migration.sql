CREATE TABLE "CliSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "appendix" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "CliSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CliSettings_singleton" CHECK ("id" = 'default'),
  CONSTRAINT "CliSettings_appendix_length" CHECK (char_length("appendix") <= 100000),
  CONSTRAINT "CliSettings_version_positive" CHECK ("version" > 0)
);

INSERT INTO "CliSettings" (
  "id",
  "appendix",
  "createdBy",
  "updatedBy"
) VALUES (
  'default',
  '',
  'migration',
  'migration'
);
