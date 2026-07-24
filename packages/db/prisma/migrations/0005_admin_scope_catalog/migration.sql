-- Global scope definitions are deliberately separate from OAuth resource metadata.
CREATE TABLE "Scope" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "Scope_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Scope_key_format" CHECK (
    "key" ~ '^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$'
    AND char_length("key") <= 160
  ),
  CONSTRAINT "Scope_description_length" CHECK (
    char_length(btrim("description")) BETWEEN 1 AND 500
  ),
  CONSTRAINT "Scope_version_positive" CHECK ("version" > 0)
);

CREATE TABLE "EmailScopeAssignment" (
  "id" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,

  CONSTRAINT "EmailScopeAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailScopeAssignment_email_normalized" CHECK (
    char_length("normalizedEmail") BETWEEN 3 AND 320
    AND "normalizedEmail" = lower(btrim("normalizedEmail"))
  ),
  CONSTRAINT "EmailScopeAssignment_version_positive" CHECK ("version" > 0)
);

CREATE TABLE "EmailScopeGrant" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT NOT NULL,

  CONSTRAINT "EmailScopeGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminAuditEvent" (
  "id" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT NOT NULL,
  "actorEmail" TEXT,
  "requestId" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminAuditEvent_schema_version_positive" CHECK ("schemaVersion" > 0),
  CONSTRAINT "AdminAuditEvent_outcome" CHECK ("outcome" IN ('success', 'denied', 'failed'))
);

CREATE UNIQUE INDEX "Scope_key_key" ON "Scope"("key");
CREATE INDEX "Scope_updatedAt_idx" ON "Scope"("updatedAt");
CREATE UNIQUE INDEX "EmailScopeAssignment_normalizedEmail_key"
  ON "EmailScopeAssignment"("normalizedEmail");
CREATE INDEX "EmailScopeAssignment_updatedAt_idx"
  ON "EmailScopeAssignment"("updatedAt");
CREATE UNIQUE INDEX "EmailScopeGrant_assignmentId_scopeId_key"
  ON "EmailScopeGrant"("assignmentId", "scopeId");
CREATE INDEX "EmailScopeGrant_scopeId_idx" ON "EmailScopeGrant"("scopeId");
CREATE INDEX "AdminAuditEvent_occurredAt_idx" ON "AdminAuditEvent"("occurredAt");
CREATE INDEX "AdminAuditEvent_eventType_occurredAt_idx"
  ON "AdminAuditEvent"("eventType", "occurredAt");
CREATE INDEX "AdminAuditEvent_actorId_occurredAt_idx"
  ON "AdminAuditEvent"("actorId", "occurredAt");
CREATE INDEX "AdminAuditEvent_subjectType_subjectId_occurredAt_idx"
  ON "AdminAuditEvent"("subjectType", "subjectId", "occurredAt");

ALTER TABLE "EmailScopeGrant"
  ADD CONSTRAINT "EmailScopeGrant_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "EmailScopeAssignment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailScopeGrant"
  ADD CONSTRAINT "EmailScopeGrant_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "Scope"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing downstream permissions become catalog entries. Creating a catalog
-- entry does not register it for a resource or grant it to anyone.
INSERT INTO "Scope" (
  "id", "key", "description", "isSystem", "version",
  "createdAt", "updatedAt", "createdBy", "updatedBy"
) VALUES
  (
    'scope-weldall-administer', 'weldall:administer',
    'Administer Weldall scopes and email assignments.', true, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  ),
  (
    'scope-expenses-read', 'expenses:read',
    'Read expenses.', false, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  ),
  (
    'scope-expenses-create', 'expenses:create',
    'Create expenses.', false, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  ),
  (
    'scope-expenses-delete', 'expenses:delete',
    'Delete expenses.', false, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  ),
  (
    'scope-expenses-write', 'expenses:write',
    'Modify expenses.', false, 1,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
  );
