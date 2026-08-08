export { db } from "./client.js";
export {
  ADMIN_SCOPE_KEY,
  LOGIN_SCOPE_KEY,
  SYSTEM_SCOPE_DEFINITIONS,
  ensureSystemScopes,
} from "./system-scopes.js";
export { Prisma, SkillVisibility } from "@prisma/client";
export type { OAuthDeviceRefreshBinding } from "@prisma/client";
