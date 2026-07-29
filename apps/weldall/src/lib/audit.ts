export const AUDIT_EVENT_TYPES = [
  "id_jag.issued",
  "id_jag.denied",
  "id_jag.failed",
  "user_scopes.created",
  "user_scopes.replaced",
  "user_scopes.deleted",
  "resource_scopes.created",
  "resource_scopes.replaced",
  "resource_scopes.deleted",
  "cli_settings.updated",
  "skill.created",
  "skill.updated",
  "skill.deleted",
  "group_provider.created",
  "group_provider.updated",
  "group_provider.deleted",
  "group_provider.tested",
  "group_scopes.created",
  "group_scopes.replaced",
  "group_scopes.deleted",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditActorType = "user" | "oauth_client" | "workload" | "anonymous";
export type AuditOutcome = "success" | "denied" | "failed";
export type AuditReasonCode =
  | "invalid_client"
  | "invalid_resource"
  | "scope_not_granted"
  | "invalid_dpop_proof"
  | "replay_detected"
  | "invalid_grant"
  | "invalid_request"
  | "internal_error"
  | "audit_store_unavailable";

export interface AuditEventDto {
  id: string;
  schemaVersion: number;
  eventType: AuditEventType;
  occurredAt: string;
  actorType: AuditActorType;
  actorId: string;
  actorEmail: string | null;
  clientId: string | null;
  requestId: string;
  correlationId: string | null;
  outcome: AuditOutcome;
  reasonCode: AuditReasonCode | null;
  subjectType: string | null;
  subjectId: string | null;
  metadata: unknown;
}
