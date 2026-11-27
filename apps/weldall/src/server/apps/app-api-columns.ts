/**
 * The catalog columns that store a registry's apps API (`DiscoveredSkillCatalog.appApi*`), cleared.
 * A refresh with app discovery off stores them so, and so does switching app discovery (or the
 * resource) off, at once and in the same write (`domain/primitive-mutations.ts`): a resource that
 * is switched on again is not listed as a registry until its metadata was read again. Kept apart
 * from `discovery.ts` so that the write paths need nothing else of app discovery.
 */
export const clearedAppApi = {
  appApiEndpoint: null,
  appApiScope: null,
  appApiAdminScope: null,
  appApiGit: null,
  appApiGitCredentials: null,
  appApiRefusal: null,
  appApiCheckedAt: null,
} as const;
