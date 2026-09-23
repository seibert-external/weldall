"use client";

import { useMemo, useState } from "react";
import type { BadgeVariant } from "@astryxdesign/core/Badge";
import type { ColumnDef, SortingState, Table as TanStackTable } from "@tanstack/react-table";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { listAuthorizations, listConnections } from "@/server/connectors/connections";
import { useTRPC } from "@/trpc/react";
import { useOperationToast } from "../../_components/use-operation-toast";
import { OverflowFade, ResizableTableHeader } from "../resizable-table";

type ServerConnectionRow = Awaited<ReturnType<typeof listConnections>>[number];
type ConnectionRow = Omit<ServerConnectionRow, "createdAt" | "updatedAt" | "lastUsedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  lastUsedAt: Date | string | null;
};
type ServerAuthorizationRow = Awaited<ReturnType<typeof listAuthorizations>>[number];
type AuthorizationRow = Omit<ServerAuthorizationRow, "expiresAt"> & {
  expiresAt: Date | string;
};
type AdminAction =
  | { type: "disconnect" | "discard-connection" | "delete-connection"; row: ConnectionRow }
  | { type: "cancel-authorization" | "discard-authorization"; row: AuthorizationRow };
const emptyConnections: ConnectionRow[] = [];
const emptyAuthorizations: AuthorizationRow[] = [];
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ConnectionsTable() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const operationToast = useOperationToast();
  const connectionsQuery = useQuery(trpc.admin.managed.connections.queryOptions());
  const authorizationsQuery = useQuery(trpc.admin.managed.authorizations.queryOptions());
  const [action, setAction] = useState<AdminAction | null>(null);
  const [connectionSearch, setConnectionSearch] = useState("");
  const [attemptSearch, setAttemptSearch] = useState("");
  const [connectionSorting, setConnectionSorting] = useState<SortingState>([
    { id: "updatedAt", desc: true },
  ]);
  const [attemptSorting, setAttemptSorting] = useState<SortingState>([
    { id: "expiresAt", desc: true },
  ]);
  const refreshConnections = () =>
    queryClient.invalidateQueries({ queryKey: trpc.admin.managed.connections.queryKey() });
  const refreshAttempts = () =>
    queryClient.invalidateQueries({ queryKey: trpc.admin.managed.authorizations.queryKey() });
  const completed = async (message: string, key: string, refresh: () => Promise<unknown>) => {
    setAction(null);
    operationToast.success(message, key);
    await refresh();
  };
  const disconnect = useMutation(
    trpc.admin.managed.disconnect.mutationOptions({
      onSuccess: () =>
        completed("Connection disconnected", "connection-disconnect", refreshConnections),
      onError: (error) =>
        operationToast.error("Could not disconnect connection", error, "connection-disconnect"),
    }),
  );
  const remove = useMutation(
    trpc.admin.managed.deleteConnection.mutationOptions({
      onSuccess: () =>
        completed("Connection metadata deleted", "connection-delete", refreshConnections),
      onError: (error) =>
        operationToast.error("Could not delete connection", error, "connection-delete"),
    }),
  );
  const discardCredentials = useMutation(
    trpc.admin.managed.discardConnection.mutationOptions({
      onSuccess: () =>
        completed("Retry credentials discarded", "connection-discard", refreshConnections),
      onError: (error) =>
        operationToast.error("Could not discard retry credentials", error, "connection-discard"),
    }),
  );
  const cancel = useMutation(
    trpc.admin.managed.cancelAuthorization.mutationOptions({
      onSuccess: () =>
        completed("Authorization attempt cancelled", "authorization-cancel", refreshAttempts),
      onError: (error) =>
        operationToast.error("Could not cancel authorization", error, "authorization-cancel"),
    }),
  );
  const discard = useMutation(
    trpc.admin.managed.discardAuthorization.mutationOptions({
      onSuccess: () =>
        completed(
          "Authorization retry material discarded",
          "authorization-discard",
          refreshAttempts,
        ),
      onError: (error) =>
        operationToast.error(
          "Could not discard authorization material",
          error,
          "authorization-discard",
        ),
    }),
  );
  const busy =
    disconnect.isPending ||
    remove.isPending ||
    discardCredentials.isPending ||
    cancel.isPending ||
    discard.isPending;

  const connectionColumns = useMemo<ColumnDef<ConnectionRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) =>
          `${row.name} ${row.accountName} ${row.owner.name ?? ""} ${row.owner.email}`,
        header: "Connection",
        size: 310,
        minSize: 210,
        maxSize: 440,
        cell: ({ row }) => (
          <OverflowFade title={`${row.original.name} · ${row.original.accountName}`}>
            <div className="grid w-max gap-0.5 whitespace-nowrap">
              <span className="font-medium">{row.original.name}</span>
              <span>{row.original.accountName}</span>
              <span className="text-secondary text-xs">
                {row.original.owner.name ?? row.original.owner.email} · {row.original.owner.email}
              </span>
            </div>
          </OverflowFade>
        ),
      },
      {
        id: "connector",
        accessorFn: (row) => row.connectorKey,
        header: "Connector",
        size: 180,
        minSize: 130,
        maxSize: 240,
        cell: ({ getValue }) => <code className="text-sm">{getValue<string>()}</code>,
      },
      {
        id: "permissions",
        accessorFn: (row) => row.capabilities.join(" "),
        header: "Effective access",
        size: 280,
        minSize: 180,
        maxSize: 420,
        cell: ({ row }) => (
          <div className="grid gap-1">
            <span>
              {row.original.capabilities.length ? row.original.capabilities.join(", ") : "None"}
            </span>
            <Text color="secondary" type="supporting">
              {row.original.selectedScopes.length} selected · {row.original.grantedScopes.length}{" "}
              granted
            </Text>
          </div>
        ),
      },
      {
        id: "status",
        accessorFn: (row) => row.status,
        header: "Health",
        size: 210,
        minSize: 160,
        maxSize: 290,
        cell: ({ row }) => (
          <div className="grid gap-1">
            <div className="flex flex-wrap gap-1">
              <Badge
                label={connectionStatusLabel(row.original.status)}
                variant={connectionStatusVariant(row.original.status)}
              />
              {!row.original.connectorEnabled ? (
                <Badge label="Connector disabled" variant="warning" />
              ) : null}
            </div>
            {row.original.revocationError ? (
              <Text className="text-danger" type="supporting">
                {row.original.revocationError}
              </Text>
            ) : null}
          </div>
        ),
      },
      {
        id: "usage",
        accessorFn: (row) => row.requestCount,
        header: "Usage",
        size: 210,
        minSize: 160,
        maxSize: 280,
        cell: ({ row }) => (
          <div className="grid gap-0.5">
            <span>{row.original.requestCount.toLocaleString()} dispatches</span>
            <Text color="secondary" type="supporting">
              Last used{" "}
              {row.original.lastUsedAt
                ? dateFormatter.format(new Date(row.original.lastUsedAt))
                : "never"}
            </Text>
          </div>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        size: 210,
        minSize: 180,
        maxSize: 280,
        cell: ({ getValue }) => (
          <time className="whitespace-nowrap">
            {dateFormatter.format(new Date(getValue<string | Date>()))}
          </time>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 320,
        minSize: 280,
        maxSize: 380,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-2">
            <Button
              isDisabled={busy || row.original.status === "DISCONNECTED"}
              label={
                row.original.status === "REVOCATION_PENDING" ? "Retry revocation" : "Disconnect"
              }
              onClick={() => setAction({ type: "disconnect", row: row.original })}
              variant="secondary"
            />
            {row.original.status === "REVOCATION_PENDING" ? (
              <Button
                isDisabled={busy}
                label="Terminal cleanup"
                onClick={() => setAction({ type: "discard-connection", row: row.original })}
                variant="secondary"
              />
            ) : null}
            {row.original.status === "DISCONNECTED" ? (
              <Button
                isDisabled={busy}
                label="Delete"
                onClick={() => setAction({ type: "delete-connection", row: row.original })}
                variant="destructive"
              />
            ) : null}
          </div>
        ),
      },
    ],
    [busy],
  );
  const authorizationColumns = useMemo<ColumnDef<AuthorizationRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => `${row.name} ${row.owner.name ?? ""} ${row.owner.email}`,
        header: "Attempt / owner",
        size: 340,
        minSize: 220,
        maxSize: 480,
        cell: ({ row }) => (
          <div className="grid gap-0.5">
            <span className="font-medium">{row.original.name}</span>
            <Text color="secondary" type="supporting">
              {row.original.owner.name ?? row.original.owner.email} · {row.original.owner.email}
            </Text>
          </div>
        ),
      },
      {
        id: "connector",
        accessorFn: (row) => row.connector.key,
        header: "Connector",
        size: 190,
        minSize: 140,
        maxSize: 260,
        cell: ({ getValue }) => <code className="text-sm">{getValue<string>()}</code>,
      },
      {
        accessorKey: "status",
        header: "Status",
        size: 180,
        minSize: 140,
        maxSize: 220,
        cell: ({ getValue }) => (
          <Badge
            label={authorizationStatusLabel(getValue<string>())}
            variant={authorizationStatusVariant(getValue<string>())}
          />
        ),
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        size: 230,
        minSize: 190,
        maxSize: 300,
        cell: ({ getValue }) => (
          <time className="whitespace-nowrap">
            {dateFormatter.format(new Date(getValue<string | Date>()))}
          </time>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 340,
        minSize: 280,
        maxSize: 400,
        enableSorting: false,
        cell: ({ row }) => {
          const expired = new Date(row.original.expiresAt).getTime() + 30_000 <= Date.now();
          return (
            <div className="flex flex-wrap gap-2">
              <Button
                isDisabled={busy || row.original.status === "COMPLETED"}
                label="Cancel / retry revocation"
                onClick={() => setAction({ type: "cancel-authorization", row: row.original })}
                variant="secondary"
              />
              <Button
                isDisabled={busy || !expired}
                label="Terminal cleanup"
                onClick={() => setAction({ type: "discard-authorization", row: row.original })}
                variant="secondary"
              />
            </div>
          );
        },
      },
    ],
    [busy],
  );
  const connectionTable = useReactTable({
    data: connectionsQuery.data ?? emptyConnections,
    columns: connectionColumns,
    state: { sorting: connectionSorting, globalFilter: connectionSearch },
    onSortingChange: setConnectionSorting,
    onGlobalFilterChange: setConnectionSearch,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const authorizationTable = useReactTable({
    data: authorizationsQuery.data ?? emptyAuthorizations,
    columns: authorizationColumns,
    state: { sorting: attemptSorting, globalFilter: attemptSearch },
    onSortingChange: setAttemptSorting,
    onGlobalFilterChange: setAttemptSearch,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const queryError = connectionsQuery.error ?? authorizationsQuery.error;

  return (
    <>
      <Text color="secondary">
        Administrators can inspect and disconnect accounts, but cannot use them. Provider revocation
        may affect other grants for the same account and OAuth client.
      </Text>
      {queryError ? (
        <Banner
          container="card"
          status="error"
          title="Could not load managed connections"
          description={queryError.message}
        />
      ) : null}
      <section className="grid gap-3" aria-labelledby="connections-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Heading id="connections-title" level={2}>
              Connections
            </Heading>
            <Text color="secondary">Up to 200 most recently created connections.</Text>
          </div>
          <TextInput
            hasClear
            isLabelHidden
            label="Find connections"
            onChange={setConnectionSearch}
            placeholder="Find connections…"
            startIcon="search"
            value={connectionSearch}
            width={280}
          />
        </div>
        <DataTable
          ariaLabel="Managed connections table"
          table={connectionTable}
          columns={connectionColumns}
          isPending={connectionsQuery.isPending}
          empty={
            connectionSearch
              ? "No connections match this search."
              : "No managed connections have been created."
          }
        />
      </section>
      <section className="grid gap-3" aria-labelledby="attempts-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Heading id="attempts-title" level={2}>
              Authorization attempts
            </Heading>
            <Text color="secondary">
              Interrupted exchanges can retain cleanup material until revocation succeeds.
            </Text>
          </div>
          <TextInput
            hasClear
            isLabelHidden
            label="Find authorization attempts"
            onChange={setAttemptSearch}
            placeholder="Find attempts…"
            startIcon="search"
            value={attemptSearch}
            width={280}
          />
        </div>
        <DataTable
          ariaLabel="Authorization attempts table"
          table={authorizationTable}
          columns={authorizationColumns}
          isPending={authorizationsQuery.isPending}
          empty={
            attemptSearch
              ? "No authorization attempts match this search."
              : "No authorization attempts are retained."
          }
        />
      </section>
      <AlertDialog
        actionLabel={actionLabel(action)}
        description={actionDescription(action)}
        isActionLoading={busy}
        isOpen={Boolean(action)}
        onAction={() =>
          runAction(action, { disconnect, remove, discardCredentials, cancel, discard })
        }
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
        title={actionTitle(action)}
      />
    </>
  );
}

function DataTable<T>({
  ariaLabel,
  table,
  columns,
  isPending,
  empty,
}: {
  ariaLabel: string;
  table: TanStackTable<T>;
  columns: ColumnDef<T>[];
  isPending: boolean;
  empty: string;
}) {
  return (
    <TableContext.Provider
      value={{
        density: "balanced",
        dividers: "grid",
        hasHover: false,
        isStriped: false,
        textOverflow: "wrap",
        verticalAlign: "middle",
      }}
    >
      <div className="w-full overflow-x-auto" role="group" aria-label={ariaLabel}>
        <table
          className="admin-resizable-table table-fixed border-collapse text-left"
          style={{ minWidth: "100%", width: table.getTotalSize() }}
        >
          <ResizableTableHeader table={table} />
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!isPending && table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <Text color="secondary">{empty}</Text>
                </TableCell>
              </TableRow>
            ) : null}
            {isPending ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <Text color="secondary">Loading…</Text>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </table>
      </div>
    </TableContext.Provider>
  );
}

function connectionStatusLabel(status: ConnectionRow["status"]) {
  return (
    {
      READY: "Ready",
      REFRESHING: "Refreshing",
      RECONNECT_REQUIRED: "Reconnect required",
      REVOCATION_PENDING: "Revocation pending",
      DISCONNECTED: "Disconnected",
    } as const
  )[status];
}
function connectionStatusVariant(status: ConnectionRow["status"]): BadgeVariant {
  return (
    {
      READY: "success",
      REFRESHING: "info",
      RECONNECT_REQUIRED: "warning",
      REVOCATION_PENDING: "error",
      DISCONNECTED: "neutral",
    } as const
  )[status];
}
function authorizationStatusLabel(status: string) {
  return status
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}
function authorizationStatusVariant(status: string): BadgeVariant {
  if (status === "COMPLETED") return "success";
  if (["FAILED", "NEEDS_REVOCATION", "REVOCATION_PENDING"].includes(status)) return "error";
  if (["EXPIRED", "CANCELLED"].includes(status)) return "neutral";
  return "info";
}
function actionLabel(action: AdminAction | null) {
  if (!action) return "Continue";
  return (
    {
      disconnect: "Disconnect",
      "discard-connection": "Discard credentials",
      "delete-connection": "Delete connection",
      "cancel-authorization": "Cancel attempt",
      "discard-authorization": "Discard retry material",
    } as const
  )[action.type];
}
function actionTitle(action: AdminAction | null) {
  if (!action) return "Confirm operation";
  return `${actionLabel(action)}?`;
}
function actionDescription(action: AdminAction | null) {
  if (!action) return "Confirm this operation.";
  switch (action.type) {
    case "disconnect":
      return `Block ${action.row.name} and revoke its Google account/client grant? This may affect other connections using that grant.`;
    case "discard-connection":
      return `Provider revocation is unconfirmed for ${action.row.name}. Permanently discard retry credentials only after revoking the grant in Google account settings.`;
    case "delete-connection":
      return `Permanently delete the disconnected connection metadata for ${action.row.name}?`;
    case "cancel-authorization":
      return `Cancel ${action.row.name} and revoke any retained Google grant? Other authorizations for the same account/client may be affected.`;
    case "discard-authorization":
      return `Provider revocation is unconfirmed. Discard the expired ${action.row.name} attempt and its encrypted retry material?`;
  }
}
function runAction(
  action: AdminAction | null,
  mutations: {
    disconnect: { mutate: (input: { id: string }) => void };
    remove: { mutate: (input: { id: string }) => void };
    discardCredentials: {
      mutate: (input: {
        id: string;
        version: number;
        acknowledgement: "provider-revocation-unconfirmed";
      }) => void;
    };
    cancel: { mutate: (input: { id: string }) => void };
    discard: {
      mutate: (input: { id: string; acknowledgement: "provider-revocation-unconfirmed" }) => void;
    };
  },
) {
  if (!action) return;
  switch (action.type) {
    case "disconnect":
      mutations.disconnect.mutate({ id: action.row.id });
      break;
    case "discard-connection":
      mutations.discardCredentials.mutate({
        id: action.row.id,
        version: action.row.version,
        acknowledgement: "provider-revocation-unconfirmed",
      });
      break;
    case "delete-connection":
      mutations.remove.mutate({ id: action.row.id });
      break;
    case "cancel-authorization":
      mutations.cancel.mutate({ id: action.row.id });
      break;
    case "discard-authorization":
      mutations.discard.mutate({
        id: action.row.id,
        acknowledgement: "provider-revocation-unconfirmed",
      });
      break;
  }
}
