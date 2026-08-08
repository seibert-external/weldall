import type { Prisma } from "@prisma/client";

export const ADMIN_SCOPE_KEY = "weldall:administer";
export const LOGIN_SCOPE_KEY = "weldall:login";

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
