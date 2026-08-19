import type { Prisma } from "@prisma/client";

export const ADMIN_SCOPE_KEY = "weldall:administer";
export const LOGIN_SCOPE_KEY = "weldall:login";
export const IAC_SCOPE_KEY = "weldall:iac";
export const SUBJECT_SCOPES_CHECK_SCOPE_KEY = "weldall:subject-scopes-check";

export const MACHINE_ONLY_SYSTEM_SCOPE_KEYS = [
  IAC_SCOPE_KEY,
  SUBJECT_SCOPES_CHECK_SCOPE_KEY,
] as const;

export function isMachineOnlySystemScope(key: string): boolean {
  return (MACHINE_ONLY_SYSTEM_SCOPE_KEYS as readonly string[]).includes(key);
}

export const SYSTEM_SCOPE_DEFINITIONS = [
  {
    id: "scope-weldall-administer",
    key: ADMIN_SCOPE_KEY,
    description: "Administer Weldall scopes and assignments.",
  },
  {
    id: "scope-weldall-login",
    key: LOGIN_SCOPE_KEY,
    description: "Authenticate and use the Weldall CLI with this server.",
  },
  {
    id: "scope-weldall-iac",
    key: IAC_SCOPE_KEY,
    description: "Plan and apply Weldall infrastructure configuration.",
  },
  {
    id: "scope-weldall-subject-scopes-check",
    key: SUBJECT_SCOPES_CHECK_SCOPE_KEY,
    description: "Check user scopes supported by an allowed downstream resource.",
  },
] as const;

export async function ensureSystemScopes(
  prisma: Prisma.TransactionClient,
  actor: string,
): Promise<void> {
  for (const definition of SYSTEM_SCOPE_DEFINITIONS) {
    const existing = await prisma.scope.findUnique({ where: { key: definition.key } });
    if (existing && (existing.id !== definition.id || !existing.isSystem)) {
      throw new Error(`System scope collision for ${definition.key}.`);
    }
    const scope = await prisma.scope.upsert({
      where: { key: definition.key },
      create: {
        ...definition,
        isSystem: true,
        createdBy: actor,
        updatedBy: actor,
      },
      update: { updatedBy: actor },
    });
    if (scope.id !== definition.id || !scope.isSystem) {
      throw new Error(`System scope collision for ${definition.key}.`);
    }
  }
}
