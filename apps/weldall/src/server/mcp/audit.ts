import type { Prisma } from "@weldall/db";
import type { ConnectorActor } from "../connectors/contracts";
import { prismaAuditWriter } from "../audit/service";

export function writeMcpAudit(input: {
  tx: Prisma.TransactionClient;
  actor: ConnectorActor;
  operation: string;
  subjectId: string;
  outcome?: "success" | "failed" | "denied";
  details: {
    connectorKey: string;
    connectorId?: string;
    ownerId?: string;
    authorizationSource?: "owner";
    toolName?: string;
    requestFingerprint?: string;
    durationMs?: number;
  };
}) {
  return prismaAuditWriter.write(
    {
      eventType: "connector.request",
      actorType: input.actor.type ?? "user",
      actorId: input.actor.id,
      requestId: input.actor.requestId,
      subjectType: "connection",
      subjectId: input.subjectId,
      outcome: input.outcome ?? "success",
      ...(input.outcome && input.outcome !== "success"
        ? { reasonCode: "invalid_request" as const }
        : {}),
      metadata: { operation: input.operation, ...input.details },
    },
    input.tx,
  );
}
