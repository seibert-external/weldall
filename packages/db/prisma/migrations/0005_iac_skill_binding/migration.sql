-- Native IaC typed ownership target for administrator-managed skills.
ALTER TABLE "IacObjectBinding" ADD COLUMN "skillId" TEXT;
CREATE UNIQUE INDEX "IacObjectBinding_skillId_key" ON "IacObjectBinding"("skillId");
ALTER TABLE "IacObjectBinding"
  ADD CONSTRAINT "IacObjectBinding_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IacObjectBinding" DROP CONSTRAINT "IacObjectBinding_kind_target_check";
ALTER TABLE "IacObjectBinding"
  ADD CONSTRAINT "IacObjectBinding_kind_target_check" CHECK (
    num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId", "skillId") = 0
    OR ("kind" = 'SCOPE' AND "scopeId" IS NOT NULL AND num_nonnulls("resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId", "skillId") = 0)
    OR ("kind" = 'RESOURCE' AND "resourceId" IS NOT NULL AND num_nonnulls("scopeId", "machineClientId", "emailAssignmentId", "groupAssignmentId", "skillId") = 0)
    OR ("kind" = 'MACHINE' AND "machineClientId" IS NOT NULL AND num_nonnulls("scopeId", "resourceId", "emailAssignmentId", "groupAssignmentId", "skillId") = 0)
    OR ("kind" = 'EMAIL_ASSIGNMENT' AND "emailAssignmentId" IS NOT NULL AND num_nonnulls("scopeId", "resourceId", "machineClientId", "groupAssignmentId", "skillId") = 0)
    OR ("kind" = 'GROUP_ASSIGNMENT' AND "groupAssignmentId" IS NOT NULL AND num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "skillId") = 0)
    OR ("kind" = 'SKILL' AND "skillId" IS NOT NULL AND num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId") = 0)
  );
