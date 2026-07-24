CREATE TABLE "Skill" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "requiredScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "Skill_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Skill_slug_format" CHECK (
    "slug" ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    AND char_length("slug") <= 120
  ),
  CONSTRAINT "Skill_title_length" CHECK (
    char_length(btrim("title")) BETWEEN 1 AND 200
  ),
  CONSTRAINT "Skill_content_length" CHECK (
    char_length(btrim("content")) BETWEEN 1 AND 100000
  ),
  CONSTRAINT "Skill_required_scopes_limit" CHECK (
    cardinality("requiredScopes") <= 100
  ),
  CONSTRAINT "Skill_version_positive" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "Skill_slug_key" ON "Skill"("slug");
CREATE INDEX "Skill_updatedAt_idx" ON "Skill"("updatedAt");
