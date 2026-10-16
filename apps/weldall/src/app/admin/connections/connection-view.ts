import type { BadgeVariant } from "@astryxdesign/core/Badge";
import type { listConnections } from "@/server/connectors/core/connections";

type ServerConnection = Awaited<ReturnType<typeof listConnections>>[number];
export type ConnectionRow = Omit<ServerConnection, "createdAt" | "updatedAt" | "lastUsedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  lastUsedAt: Date | string | null;
};

export const connectionStatuses = {
  READY: { label: "Ready", variant: "success" },
  DISABLED: { label: "Disabled", variant: "warning" },
  REFRESHING: { label: "Refreshing", variant: "info" },
  RECONNECT_REQUIRED: { label: "Reconnect required", variant: "warning" },
  REVOCATION_PENDING: { label: "Disconnect pending", variant: "error" },
} as const satisfies Record<ConnectionRow["status"], { label: string; variant: BadgeVariant }>;

export function connectionBadge(row: Pick<ConnectionRow, "enabled" | "hasCredential" | "status">) {
  if (!row.hasCredential)
    return { label: "Disabled — credential missing", variant: "warning" as const };
  if (!row.enabled) return connectionStatuses.DISABLED;
  return connectionStatuses[row.status];
}

export type ConnectionFilters = {
  search: string;
  status: string;
  connector: string;
  access: string;
};
type FilterableConnection = Pick<
  ConnectionRow,
  | "name"
  | "accountName"
  | "owner"
  | "connectorKey"
  | "status"
  | "enabled"
  | "hasCredential"
  | "accessMode"
  | "key"
  | "useScopes"
>;

/** Combines overview filters; only metadata participates, never credentials. */
export function filterConnections<T extends FilterableConnection>(
  rows: readonly T[],
  filters: ConnectionFilters,
): T[] {
  const needle = filters.search.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (!filters.access || row.accessMode === filters.access) &&
      (!filters.status ||
        (!row.enabled || !row.hasCredential ? "DISABLED" : row.status) === filters.status) &&
      (!filters.connector || row.connectorKey === filters.connector) &&
      (!needle ||
        [
          row.name,
          row.accountName,
          row.owner.name ?? "",
          row.owner.email,
          row.connectorKey,
          row.key ?? "",
          row.accessMode,
          ...row.useScopes,
        ].some((value) => value.toLocaleLowerCase().includes(needle))),
  );
}
