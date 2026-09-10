export const AUDIT_EVENT_TYPES = [
  "login.installation.completed",
  "login.provider.saved",
  "id_jag.issued",
  "id_jag.denied",
  "id_jag.failed",
  "machine_client.created",
  "machine_client.updated",
  "machine_client.deactivated",
  "machine_client.deleted",
  "machine_key.registered",
  "machine_key.revoked",
  "machine_access.replaced",
  "machine_token.issued",
  "machine_token.denied",
  "machine_token.failed",
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
  "iac.plan.generated",
  "iac.apply.succeeded",
  "iac.apply.denied",
  "iac.apply.failed",
  "iac.object.imported",
  "iac.object.unmanaged",
  "iac.state.moved",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditActorType = "user" | "oauth_client" | "machine" | "anonymous";
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
