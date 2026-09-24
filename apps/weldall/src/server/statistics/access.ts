import { STATISTICS_SCOPE_KEY } from "@weldall/db";
import { normalizeEmail } from "../admin/service";
import { hasEffectiveSystemScopeFor } from "../policy/resources";

/** `weldall:administer` does not imply this: the scope list alone says who sees org-wide usage. */
export async function canViewStatistics(email: string): Promise<boolean> {
  let normalizedEmail: string;
  try {
    normalizedEmail = normalizeEmail(email);
  } catch {
    return false;
  }
  return hasEffectiveSystemScopeFor(normalizedEmail, STATISTICS_SCOPE_KEY);
}
