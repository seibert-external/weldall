import type { Prisma } from "@weldall/db";
import type { ConnectorActor } from "../contracts";
import { writeConnectorAuditLog } from "../audit";

/**
 * Removes local connection state without provider I/O or decryption. The caller must use a
 * serializable transaction; foreign keys and callback/refresh claims fence concurrent writers.
 * Connector deletion also removes setup attempts that have not produced a connection yet.
 */
export async function deleteConnectionState({
  tx,
  target,
  actor,
}: {
  tx: Prisma.TransactionClient;
  target: { connectorId: string } | { connectionId: string };
  actor: ConnectorActor;
}) {
  const connections = await tx.connection.findMany({
    where:
      "connectorId" in target ? { connectorId: target.connectorId } : { id: target.connectionId },
    select: { id: true, connectorId: true, credentialId: true, accountId: true },
  });
  const attempts = await tx.connectionAuthorization.findMany({
    where: target,
    select: { id: true, connectorId: true, payloadId: true },
  });
  await tx.connectionAuthorization.deleteMany({
    where: { id: { in: attempts.map(({ id }) => id) } },
  });
  await tx.connection.deleteMany({ where: { id: { in: connections.map(({ id }) => id) } } });
  const encryptedIds = [
    ...connections.map(({ credentialId }) => credentialId),
    ...attempts.map(({ payloadId }) => payloadId),
  ].filter((id): id is string => id !== null);
  await tx.encryptedValue.deleteMany({ where: { id: { in: encryptedIds } } });
  for (const connection of connections) {
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: connection.id,
      operation: "connection.deleted",
      details: { connectorId: connection.connectorId, accountId: connection.accountId },
    });
  }
  for (const attempt of attempts) {
    await writeConnectorAuditLog({
      tx,
      actor,
      event: "lifecycle",
      subjectId: attempt.id,
      operation: "authorization.deleted",
      details: { connectorId: attempt.connectorId },
    });
  }
}
