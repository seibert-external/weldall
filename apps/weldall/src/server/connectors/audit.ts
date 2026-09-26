import { createHmac } from "node:crypto";
import type { Prisma } from "@weldall/db";
import { ConnectorError } from "./errors";
import { prismaAuditWriter } from "../audit/service";
import type { ConnectorActor } from "./contracts";

/** Domain-separated keyed fingerprints support correlation without persisting provider URLs. */
export function fingerprintConnectorRequest({
  method,
  requestedUrl,
}: {
  method: string;
  requestedUrl: URL;
}) {
  const encoded = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new ConnectorError("audit_unavailable", "Connector audit key is unavailable.", 503);
  try {
    const auditKey = createHmac("sha256", key)
      .update("weldall:connector-request-audit:v1")
      .digest();
    try {
      return createHmac("sha256", auditKey).update(`${method}\n${requestedUrl.href}`).digest("hex");
    } finally {
      auditKey.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

interface WriteConnectorAuditLogInput {
  tx: Prisma.TransactionClient;
  actor: ConnectorActor;
  event: "configuration" | "lifecycle" | "request";
  subjectId: string;
  operation: string;
  outcome?: "success" | "failed" | "denied";
  details?: {
    connectorId?: string;
    accountId?: string;
    durationMs?: number;
    status?: number;
    provider?: string;
    method?: string;
    requestFingerprint?: string;
  };
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
          ? "connector"
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
