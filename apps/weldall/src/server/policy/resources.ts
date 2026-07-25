import { db, Prisma } from "@weldall/db";
import type { ResourceRegistryEntry } from "@weldall/oauth";
import { normalizeEmail } from "../admin/service";

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

export async function resourceRegistryFor(email: string): Promise<ResourceRegistryEntry[]> {
  const normalizedEmail = normalizeEmail(email);
  const [resources, grants] = await Promise.all([
    db.downstreamResource.findMany({
      where: { enabled: true },
      orderBy: [{ name: "asc" }, { key: "asc" }],
      include: {
        requestPrefixes: { orderBy: { urlPrefix: "asc" } },
        scopes: { include: { scope: { select: { key: true } } } },
      },
    }),
    db.emailScopeGrant.findMany({
      where: { assignment: { normalizedEmail } },
      select: { scope: { select: { key: true } } },
    }),
  ]);
  const granted = new Set(grants.map((grant) => grant.scope.key));
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
