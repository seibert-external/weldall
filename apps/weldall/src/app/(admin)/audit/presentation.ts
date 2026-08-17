import type { AuditEventType } from "@/lib/audit";

const browserEventLabels: Partial<Record<AuditEventType, string>> = {
  "browser_connection.requested": "Browser connection requested",
  "browser_connection.approved": "Browser connection approved",
  "browser_connection.denied": "Browser connection denied",
  "browser_connection.issued": "Browser connection issued",
  "browser_connection.revoked": "Browser connection revoked",
  "browser_connection.failed": "Browser connection failed",
};

export function auditEventLabel(eventType: AuditEventType): string {
  return browserEventLabels[eventType] ?? eventType;
}

export function auditMetadataEntries(metadata: unknown): [string, string][] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return Object.entries(metadata as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => [humanizeMetadataKey(key), formatMetadataValue(value)]);
}

function humanizeMetadataKey(key: string): string {
  return key
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(formatMetadataValue).join(", ");
  return JSON.stringify(value);
}
