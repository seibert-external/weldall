import type { Prisma } from "@weldall/db";
import { prismaAuditWriter } from "../audit/service";
import type { ConnectorActor } from "./contracts";

interface WriteConnectorAuditLogInput {
  tx: Prisma.TransactionClient;
  actor: ConnectorActor;
  event: "configuration" | "lifecycle" | "request";
  subjectId: string;
  operation: string;
  outcome?: "success" | "failed" | "denied";
  details?: { connectorId?: string; accountId?: string; durationMs?: number; status?: number };
}

/**
 * Writes the canonical audit record for managed-connector configuration, lifecycle, and proxy
 * activity so every admin or owner operation appears in Weldall's shared audit stream.
 */
export function writeConnectorAuditLog({
  tx,
  actor,
  event,
  subjectId,
  operation,
  outcome = "success",
  details = {},
}: WriteConnectorAuditLogInput) {
  return prismaAuditWriter.write(
    {
      eventType: `connector.${event}`,
      actorType: actor.type ?? "user",
      actorId: actor.id,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      requestId: actor.requestId,
      subjectType:
        event === "configuration"
          ? operation.startsWith("key.")
            ? "encryption_key"
            : "connector"
          : operation.startsWith("authorization.")
            ? "connection_authorization"
            : "connection",
      subjectId,
      outcome,
      ...(outcome !== "success" ? { reasonCode: "invalid_request" as const } : {}),
      metadata: { operation, ...details },
    },
    tx,
  );
}
