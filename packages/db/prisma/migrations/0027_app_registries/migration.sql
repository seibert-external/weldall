-- App registries: a resource with app discovery switched on may name in its metadata the API
-- people's clients publish apps through (`weldall_apps_api`). Weldall checks it against the
-- resource's registration during the catalog refresh and stores what passed, or why it did not, so
-- that clients are told which resource is a registry by an administrator's act rather than by the
-- resource itself.
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appApiEndpoint" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appApiScope" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appApiAdminScope" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appApiGit" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appApiGitCredentials" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appApiRefusal" TEXT;
ALTER TABLE "DiscoveredSkillCatalog" ADD COLUMN "appApiCheckedAt" TIMESTAMP(3);
