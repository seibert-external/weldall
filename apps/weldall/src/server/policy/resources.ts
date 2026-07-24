import { db } from "@weldall/db";
import {
  DOWNSTREAM_CLIENT_ID,
  EXPENSES_ISSUER,
  EXPENSES_RESOURCE,
  type ResourceGrant,
} from "@weldall/oauth";
import { normalizeEmail } from "../admin/service";

export const expenses = {
  name: "expenses",
  authorizationServer: EXPENSES_ISSUER,
  resource: EXPENSES_RESOURCE,
  downstreamClientId: DOWNSTREAM_CLIENT_ID,
  supportedScopes: [
    "expenses:read",
    "expenses:create",
    "expenses:delete",
    "expenses:write",
  ] as const,
};

export async function grantsFor(email: string): Promise<ResourceGrant[]> {
  const grants = await db.emailScopeGrant.findMany({
    where: { assignment: { normalizedEmail: normalizeEmail(email) } },
    select: { scope: { select: { key: true } } },
  });
  const assigned = new Set(grants.map((grant) => grant.scope.key));
  const scopes = expenses.supportedScopes.filter((scope) => assigned.has(scope)).sort();
  if (!scopes.length) return [];

  return [
    {
      name: expenses.name,
      authorizationServer: expenses.authorizationServer,
      resource: expenses.resource,
      downstreamClientId: expenses.downstreamClientId,
      scopes,
    },
  ];
}
