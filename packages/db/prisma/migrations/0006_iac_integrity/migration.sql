-- Tighten IaC singleton and typed ownership invariants after the initial migration.
ALTER TABLE "IacInstallation"
  ADD CONSTRAINT "IacInstallation_singleton_id" CHECK ("id" = 'default');

ALTER TABLE "IacObjectBinding"
  DROP CONSTRAINT "IacObjectBinding_one_target_check";
ALTER TABLE "IacObjectBinding"
  ADD CONSTRAINT "IacObjectBinding_kind_target_check" CHECK (
    num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId") = 0
    OR ("kind" = 'SCOPE' AND "scopeId" IS NOT NULL AND num_nonnulls("resourceId", "machineClientId", "emailAssignmentId", "groupAssignmentId") = 0)
    OR ("kind" = 'RESOURCE' AND "resourceId" IS NOT NULL AND num_nonnulls("scopeId", "machineClientId", "emailAssignmentId", "groupAssignmentId") = 0)
    OR ("kind" = 'MACHINE' AND "machineClientId" IS NOT NULL AND num_nonnulls("scopeId", "resourceId", "emailAssignmentId", "groupAssignmentId") = 0)
    OR ("kind" = 'EMAIL_ASSIGNMENT' AND "emailAssignmentId" IS NOT NULL AND num_nonnulls("scopeId", "resourceId", "machineClientId", "groupAssignmentId") = 0)
    OR ("kind" = 'GROUP_ASSIGNMENT' AND "groupAssignmentId" IS NOT NULL AND num_nonnulls("scopeId", "resourceId", "machineClientId", "emailAssignmentId") = 0)
  );
