-- Promote the existing admin change log to the shared, append-only audit log.
ALTER TABLE "AdminAuditEvent" RENAME TO "AuditEvent";

ALTER TABLE "AuditEvent"
  ADD COLUMN "actorType" TEXT,
  ADD COLUMN "clientId" TEXT,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "deduplicationKey" TEXT,
  ADD COLUMN "reasonCode" TEXT;

UPDATE "AuditEvent"
SET "actorType" = CASE
  WHEN "actorId" IN ('deployment-bootstrap', 'migration') THEN 'workload'
  ELSE 'user'
END;

ALTER TABLE "AuditEvent"
  ALTER COLUMN "actorType" SET NOT NULL,
  ALTER COLUMN "subjectType" DROP NOT NULL,
  ALTER COLUMN "subjectId" DROP NOT NULL;

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_actor_type" CHECK (
    "actorType" IN ('user', 'oauth_client', 'workload', 'anonymous')
  ),
  ADD CONSTRAINT "AuditEvent_event_type" CHECK (
    "eventType" IN (
      'id_jag.issued', 'id_jag.denied', 'id_jag.failed',
      'user_scopes.created', 'user_scopes.replaced', 'user_scopes.deleted',
      'resource_scopes.created', 'resource_scopes.replaced', 'resource_scopes.deleted',
      'cli_settings.updated', 'skill.created', 'skill.updated', 'skill.deleted'
    )
  ) NOT VALID,
  ADD CONSTRAINT "AuditEvent_request_id" CHECK (
    "requestId" ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  ADD CONSTRAINT "AuditEvent_correlation_id" CHECK (
    "correlationId" IS NULL OR "correlationId" ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  ADD CONSTRAINT "AuditEvent_outcome_reason" CHECK (
    ("outcome" = 'success' AND "reasonCode" IS NULL)
    OR
    ("outcome" IN ('denied', 'failed') AND "reasonCode" IS NOT NULL)
  ),
  ADD CONSTRAINT "AuditEvent_reason_code" CHECK (
    "reasonCode" IS NULL OR "reasonCode" IN (
      'invalid_client', 'invalid_resource', 'scope_not_granted',
      'invalid_dpop_proof', 'replay_detected', 'invalid_grant',
      'invalid_request', 'internal_error', 'audit_store_unavailable'
    )
  ),
  ADD CONSTRAINT "AuditEvent_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
  ADD CONSTRAINT "AuditEvent_subject_pair" CHECK (
    ("subjectType" IS NULL) = ("subjectId" IS NULL)
  );

-- The NOT VALID constraint preserves historical names while enforcing the
-- controlled set for every new row.

DROP INDEX IF EXISTS "AdminAuditEvent_occurredAt_idx";
DROP INDEX IF EXISTS "AdminAuditEvent_eventType_occurredAt_idx";
DROP INDEX IF EXISTS "AdminAuditEvent_actorId_occurredAt_idx";
DROP INDEX IF EXISTS "AdminAuditEvent_subjectType_subjectId_occurredAt_idx";

CREATE UNIQUE INDEX "AuditEvent_deduplicationKey_key"
  ON "AuditEvent"("deduplicationKey");
CREATE INDEX "AuditEvent_occurredAt_id_idx"
  ON "AuditEvent"("occurredAt", "id");
CREATE INDEX "AuditEvent_eventType_occurredAt_id_idx"
  ON "AuditEvent"("eventType", "occurredAt", "id");
CREATE INDEX "AuditEvent_actorId_occurredAt_id_idx"
  ON "AuditEvent"("actorId", "occurredAt", "id");
CREATE INDEX "AuditEvent_actorEmail_occurredAt_id_idx"
  ON "AuditEvent"("actorEmail", "occurredAt", "id");
CREATE INDEX "AuditEvent_subjectType_subjectId_occurredAt_id_idx"
  ON "AuditEvent"("subjectType", "subjectId", "occurredAt", "id");

-- The application intentionally has no mutation API. Explicit grants for a
-- dedicated runtime role may add SELECT/INSERT, but never UPDATE/DELETE.
REVOKE UPDATE, DELETE ON TABLE "AuditEvent" FROM PUBLIC;
