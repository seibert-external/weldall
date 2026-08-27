CREATE TABLE "SkillRetrievalEvent" (
  "id" TEXT NOT NULL,
  "skillSlug" TEXT NOT NULL,
  "retrieverId" TEXT NOT NULL,
  "retrieverName" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SkillRetrievalEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SkillRetrievalEvent_skillSlug_occurredAt_id_idx" ON "SkillRetrievalEvent"("skillSlug", "occurredAt", "id");
CREATE INDEX "SkillRetrievalEvent_skillSlug_retrieverId_occurredAt_id_idx" ON "SkillRetrievalEvent"("skillSlug", "retrieverId", "occurredAt", "id");
