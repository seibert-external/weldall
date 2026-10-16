import { db, Prisma } from "@weldall/db";
import { prepareEffectiveScopesRequiringSystemScopeFor } from "../../policy/resources";
import { ConnectorError, type AuthorizedConnectorActor } from "../contracts";
import { canAccessConnector, connectorScopeInclude } from "../access";

export const connectionUseInclude = {
  connector: { include: connectorScopeInclude },
  useScopes: { include: { scope: { select: { key: true } } } },
} as const;

export function connectionDenied(): never {
  throw new ConnectorError("connection_denied", "Connection is not available to this caller.", 403);
}

export function canUseConnection(
  row: {
    ownerId: string;
    accessMode: "OWNER_ONLY" | "SCOPED";
    key: string | null;
    useScopes: { scope: { key: string } }[];
  },
  actor: AuthorizedConnectorActor,
): boolean {
  if (row.accessMode === "OWNER_ONLY")
    return (
      actor.type !== "machine" &&
      row.ownerId === actor.id &&
      row.key === null &&
      row.useScopes.length === 0
    );
  return (
    row.key !== null &&
    row.useScopes.length > 0 &&
    row.useScopes.every(({ scope }) => actor.scopeKeys.some((key) => key === scope.key))
  );
}

/** Preparation performs remote I/O without holding a transaction or a database connection. */
async function prepareConnectorActor(actor: AuthorizedConnectorActor) {
  if (actor.type === "machine")
    return async (tx: Prisma.TransactionClient): Promise<AuthorizedConnectorActor> => {
      // Token scopes remain an upper bound on current database assignments.
      const machine = await tx.machineClient.findUnique({
        where: { id: actor.id },
        include: { keys: true, allowedScopes: { include: { scope: true } } },
      });
      if (
        !machine?.enabled ||
        machine.deactivatedAt ||
        machine.clientId !== actor.clientId ||
        !machine.keys.some(
          (key) =>
            key.kid === actor.keyId && key.thumbprint === actor.keyThumbprint && !key.revokedAt,
        )
      )
        connectionDenied();
      const scopeKeys = actor.scopeKeys.filter((key) =>
        machine.allowedScopes.some(({ scope }) => scope.key === key),
      );
      if (!scopeKeys.some((key) => key === "weldall:mcp")) connectionDenied();
      return { ...actor, scopeKeys };
    };
  const user = await db.user.findUnique({ where: { id: actor.id }, select: { email: true } });
  if (!user) connectionDenied();
  const readScopes = await prepareEffectiveScopesRequiringSystemScopeFor({
    email: user.email,
    requiredSystemScope: "weldall:login",
  });
  return async (tx: Prisma.TransactionClient): Promise<AuthorizedConnectorActor> => {
    const current = await tx.user.findUnique({ where: { id: actor.id }, select: { email: true } });
    if (!current || current.email !== user.email) connectionDenied();
    const scopeKeys = await readScopes(tx);
    if (!scopeKeys) connectionDenied();
    return { ...actor, scopeKeys };
  };
}

export async function liveConnectorActor(actor: AuthorizedConnectorActor) {
  const readActor = await prepareConnectorActor(actor);
  return db.$transaction(readActor, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

/** Prepare outside a transaction; every resolution still reads its live grants and connection state. */
export async function prepareConnectionAccess(actor: AuthorizedConnectorActor) {
  const readActor = await prepareConnectorActor(actor);
  return async (tx: Prisma.TransactionClient, selector: string) => {
    if (!selector || selector.length > 160) connectionDenied();
    // Resolve IDs globally first: an inaccessible ID must not fall through to a shadowing name/key.
    const row =
      (await tx.connection.findUnique({
        where: { id: selector },
        include: connectionUseInclude,
      })) ??
      (actor.type !== "machine"
        ? await tx.connection.findFirst({
            where: { ownerId: actor.id, name: selector, accessMode: "OWNER_ONLY" },
            include: connectionUseInclude,
          })
        : null) ??
      (await tx.connection.findUnique({ where: { key: selector }, include: connectionUseInclude }));
    if (!row) connectionDenied();
    const live = await readActor(tx);
    if (
      !canUseConnection(row, live) ||
      !row.connector.enabled ||
      !["READY", "REFRESHING"].includes(row.status) ||
      !canAccessConnector({ connector: row.connector, actor: live })
    )
      connectionDenied();
    return {
      row,
      authorizationSource: row.accessMode === "SCOPED" ? ("scope" as const) : ("owner" as const),
    };
  };
}

/** Fresh standalone resolution, including group membership lookup, before each upstream dispatch. */
export async function resolveUsableConnection({
  actor,
  selector,
}: {
  actor: AuthorizedConnectorActor;
  selector: string;
}) {
  const resolve = await prepareConnectionAccess(actor);
  return db.$transaction((tx) => resolve(tx, selector), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}
