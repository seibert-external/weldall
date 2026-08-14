import type { Prisma } from "@weldall/db";

/**
 * Global configuration mutation lock order.
 *
 * Every browser-admin and IaC mutation takes CONFIGURATION first. Operations
 * which also mutate skill/scope references then take SKILL_SCOPE second. Row
 * locks and writes are acquired only after both advisory locks. Keeping this
 * order in one module prevents browser writes from interleaving with an IaC
 * snapshot and avoids advisory-lock inversions.
 */
export const CONFIGURATION_LOCK = 49_350_618;
export const SKILL_SCOPE_LOCK = 49_350_617;

export async function lockConfigurationChanges(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CONFIGURATION_LOCK})`;
}

export async function lockSkillScopeChanges(tx: Prisma.TransactionClient): Promise<void> {
  await lockConfigurationChanges(tx);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SKILL_SCOPE_LOCK})`;
}

export type ManagementMetadata =
  | { type: "manual" }
  | {
      type: "iac";
      workspaceId: string;
      workspaceName: string;
      address: string;
    };

export const managementBindingInclude = {
  include: { workspace: { select: { id: true, name: true } } },
} as const;

export function managementMetadata(
  binding:
    | {
        address: string;
        workspace: { id: string; name: string };
      }
    | null
    | undefined,
): ManagementMetadata {
  return binding
    ? {
        type: "iac",
        workspaceId: binding.workspace.id,
        workspaceName: binding.workspace.name,
        address: binding.address,
      }
    : { type: "manual" };
}
