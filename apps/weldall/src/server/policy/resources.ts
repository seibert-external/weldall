import { db, Prisma } from "@weldall/db";
import type { ResourceRegistryEntry } from "@weldall/sdk";
import { normalizeEmail } from "../admin/service";

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

export async function assignedScopesFor(email: string): Promise<string[]> {
  const grants = await db.emailScopeGrant.findMany({
    where: { assignment: { normalizedEmail: normalizeEmail(email) } },
    select: { scope: { select: { key: true } } },
  });
  return sortedUnique(grants.map((grant) => grant.scope.key));
}

export async function resourceRegistryFor(email: string): Promise<ResourceRegistryEntry[]> {
  const [resources, assignedScopes] = await Promise.all([
    db.downstreamResource.findMany({
      where: { enabled: true },
      orderBy: [{ name: "asc" }, { key: "asc" }],
      include: {
        requestPrefixes: { orderBy: { urlPrefix: "asc" } },
        scopes: { include: { scope: { select: { key: true } } } },
      },
    }),
    assignedScopesFor(email),
  ]);
  const granted = new Set(assignedScopes);
  return resources.map((resource) => {
    const supportedScopes = sortedUnique(resource.scopes.map(({ scope }) => scope.key));
    return {
      key: resource.key,
      name: resource.name,
      resourceIdentifier: resource.resourceIdentifier,
      authorizationServer: resource.authorizationServer,
      downstreamClientId: resource.downstreamClientId,
      requestPrefixes: resource.requestPrefixes.map((prefix) => prefix.urlPrefix),
      supportedScopes,
      grantedScopes: supportedScopes.filter((scope) => granted.has(scope)),
    };
  });
}

export async function exchangePolicyFor(input: {
  email: string;
  resourceIdentifier: string;
  authorizationServer: string;
}): Promise<{
  resourceIdentifier: string;
  authorizationServer: string;
  downstreamClientId: string;
  supportedScopes: string[];
  grantedScopes: string[];
} | null> {
  const normalizedEmail = normalizeEmail(input.email);
  return db.$transaction(
    async (tx) => {
      const resource = await tx.downstreamResource.findFirst({
        where: {
          enabled: true,
          resourceIdentifier: input.resourceIdentifier,
          authorizationServer: input.authorizationServer,
        },
        include: { scopes: { include: { scope: { select: { key: true } } } } },
      });
      if (!resource) return null;
      const supportedScopes = sortedUnique(resource.scopes.map(({ scope }) => scope.key));
      const grants = await tx.emailScopeGrant.findMany({
        where: {
          assignment: { normalizedEmail },
          scope: { key: { in: supportedScopes } },
        },
        select: { scope: { select: { key: true } } },
      });
      return {
        resourceIdentifier: resource.resourceIdentifier,
        authorizationServer: resource.authorizationServer,
        downstreamClientId: resource.downstreamClientId,
        supportedScopes,
        grantedScopes: sortedUnique(grants.map(({ scope }) => scope.key)),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
