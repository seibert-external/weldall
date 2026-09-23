import type { Prisma } from "@weldall/db";
import { prismaAuditWriter } from "../audit/service";
import type { ConnectorActor } from "./contracts";

export function connectorAudit(
  tx: Prisma.TransactionClient,
  actor: ConnectorActor,
  event: "configuration" | "lifecycle" | "request",
  subjectId: string,
  operation: string,
  outcome: "success" | "failed" | "denied" = "success",
  details: { connectorId?: string; accountId?: string; durationMs?: number; status?: number } = {},
) {
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
