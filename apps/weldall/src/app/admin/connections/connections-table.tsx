"use client";

import { useMemo } from "react";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Selector } from "@astryxdesign/core/Selector";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { AdminPersonalConnectionDto } from "@/server/connectors/admin-service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { OverflowFade, ResizableTableHeader } from "../resizable-table";
import { createSortingParser, resolveUpdater } from "../table-state";

const PAGE_SIZE = 50;
const sortingParser = createSortingParser(new Set(["name", "updatedAt"]), [
  { id: "updatedAt", desc: true },
]);
const statuses = ["ready", "reconnect_required"] as const;
type Status = (typeof statuses)[number];
const statusOptions = statuses.map((value) => ({ value, label: statusLabel(value) }));
const emptyRows: AdminPersonalConnectionDto[] = [];
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ConnectionsTable() {
  const trpc = useTRPC();
  const [{ q, page, status, connector, sort: sorting }, setQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      page: parseAsInteger.withDefault(1),
      status: parseAsString.withDefault(""),
      connector: parseAsString.withDefault(""),
      sort: sortingParser,
    },
    { history: "replace", shallow: true },
  );
  const selectedStatus = statuses.includes(status as Status) ? (status as Status) : undefined;
  const query = useQuery(
    trpc.admin.connections.list.queryOptions({
      page,
      pageSize: PAGE_SIZE,
      q,
      status: selectedStatus,
      connectorId: connector || undefined,
      sort: sortingToApi(sorting),
    }),
  );
  const connectorsQuery = useQuery(trpc.admin.connectors.list.queryOptions());
  const rows = query.data?.items ?? emptyRows;
  const columns = useMemo<ColumnDef<AdminPersonalConnectionDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Connection",
        size: 220,
        cell: ({ row, getValue }) => (
          <OverflowFade title={getValue<string>()}>
            <a
              className="font-medium underline"
              href={`/admin/connections/${encodeURIComponent(row.original.id)}`}
            >
              {getValue<string>()}
            </a>
          </OverflowFade>
        ),
      },
      {
        id: "owner",
        header: "Owner",
        size: 220,
        enableSorting: false,
        cell: ({ row }) => (
          <OverflowFade title={`${row.original.owner.name} (${row.original.owner.email})`}>
            <div className="grid w-max gap-0.5 whitespace-nowrap">
              <span>{row.original.owner.name}</span>
              <span className="text-xs">{row.original.owner.email}</span>
            </div>
          </OverflowFade>
        ),
      },
      {
        id: "connector",
        header: "Connector",
        size: 150,
        enableSorting: false,
        cell: ({ row }) => row.original.connector.name,
      },
      {
        accessorKey: "status",
        header: "Status",
        size: 170,
        enableSorting: false,
        cell: ({ getValue }) => {
          const value = getValue<Status>();
          return <Badge label={statusLabel(value)} variant={statusVariant(value)} />;
        },
      },
      {
        id: "account",
        header: "Google account",
        size: 220,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.accountDisplayName ? (
            <OverflowFade title={row.original.accountDisplayName}>
              <span className="whitespace-nowrap">{row.original.accountDisplayName}</span>
            </OverflowFade>
          ) : null,
      },
      {
        accessorKey: "lastLeaseAt",
        header: "Last lease",
        size: 180,
        cell: ({ getValue }) => {
          const value = getValue<string | null>();
          return value ? dateFormatter.format(new Date(value)) : "Never";
        },
      },
    ],
    [],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    manualSorting: true,
    columnResizeMode: "onChange",
    onSortingChange: (updater: Updater<SortingState>) => {
      void setQuery({ sort: resolveUpdater(updater, sorting), page: 1 });
    },
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <Button href="/admin/connectors" label="Manage connectors" variant="secondary" />
      </HerocrumbsActions>
      <div className="admin-audit-filters" aria-label="Connection filters">
        <TextInput
          hasClear
          isLabelHidden
          label="Find connections"
          onChange={(value) => void setQuery({ q: value || null, page: 1 })}
          placeholder="Name, account, or owner…"
          startIcon="search"
          value={q}
          width={280}
        />
        <Selector
          hasClear
          isLabelHidden
          label="Connector"
          onChange={(value) => void setQuery({ connector: value ?? null, page: 1 })}
          options={(connectorsQuery.data ?? []).map((item) => ({
            value: item.id,
            label: item.name,
          }))}
          placeholder="All connectors"
          value={connector || null}
          width={240}
        />
        <Selector
          hasClear
          isLabelHidden
          label="Status"
          onChange={(value) => void setQuery({ status: value ?? null, page: 1 })}
          options={statusOptions}
          placeholder="All statuses"
          value={selectedStatus ?? null}
          width={220}
        />
      </div>
      {query.error ? (
        <Banner
          container="card"
          description={query.error.message}
          status="error"
          title="Could not load connections"
        />
      ) : null}
      <div>
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
          <div className="w-full overflow-x-auto" role="group" aria-label="Connections table">
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
                {!query.isPending && rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">No connections match these filters.</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {query.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading connections…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="Connection pages"
            onChange={(next) => void setQuery({ page: next })}
            page={page}
            pageSize={PAGE_SIZE}
            totalItems={query.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>
    </>
  );
}

function statusLabel(status: Status) {
  const labels: Record<Status, string> = {
    ready: "Ready",
    reconnect_required: "Reconnect required",
  };
  return labels[status];
}

function statusVariant(status: Status): "success" | "warning" | "neutral" {
  return status === "ready" ? "success" : "warning";
}

function sortingToApi(sorting: SortingState) {
  const first = sorting[0] ?? { id: "updatedAt", desc: true };
  return `${first.id}.${first.desc ? "desc" : "asc"}` as
    "updatedAt.asc" | "updatedAt.desc" | "name.asc" | "name.desc";
}
