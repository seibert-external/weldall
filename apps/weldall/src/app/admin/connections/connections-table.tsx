"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { parseAsString, useQueryStates } from "nuqs";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";
import { connectionStatuses, filterConnections, type ConnectionRow } from "./connection-view";

const emptyConnections: ConnectionRow[] = [];
const statusOptions = Object.entries(connectionStatuses).map(([value, { label }]) => ({
  value,
  label,
}));
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Compact connection overview; inspection and destructive actions live on the detail page. */
export function ConnectionsTable() {
  const router = useRouter();
  const trpc = useTRPC();
  const connectionsQuery = useQuery(trpc.admin.managed.connections.queryOptions());
  const data = connectionsQuery.data ?? emptyConnections;
  const [filters, setFilters] = useQueryStates(
    {
      search: parseAsString.withDefault(""),
      status: parseAsString.withDefault(""),
      connector: parseAsString.withDefault(""),
    },
    { history: "replace", shallow: true },
  );
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const connections = useMemo(() => filterConnections(data, filters), [data, filters]);
  const connectorOptions = useMemo(
    () =>
      [...new Set(data.map((row) => row.connectorKey))]
        .sort()
        .map((value) => ({ value, label: value })),
    [data],
  );
  const hasFilters = Boolean(filters.search || filters.status || filters.connector);
  const columns = useMemo<ColumnDef<ConnectionRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Connection",
        size: 300,
        minSize: 180,
        maxSize: 440,
        cell: ({ row }) => (
          <OverflowFade title={`${row.original.name} · ${row.original.accountName}`}>
            <div className="grid w-max gap-0.5 whitespace-nowrap">
              <span className="font-medium">{row.original.name}</span>
              <span className="text-secondary text-xs">{row.original.accountName}</span>
            </div>
          </OverflowFade>
        ),
      },
      {
        id: "owner",
        accessorFn: (row) => row.owner.name ?? row.owner.email,
        header: "Owner",
        size: 250,
        minSize: 170,
        maxSize: 360,
        cell: ({ row }) => (
          <OverflowFade title={row.original.owner.email}>
            {row.original.owner.name ?? row.original.owner.email}
          </OverflowFade>
        ),
      },
      {
        accessorKey: "connectorKey",
        header: "Connector",
        size: 180,
        minSize: 140,
        maxSize: 280,
        cell: ({ getValue }) => (
          <OverflowFade title={getValue<string>()}>
            <code className="text-sm">{getValue<string>()}</code>
          </OverflowFade>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        size: 200,
        minSize: 160,
        maxSize: 270,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            <Badge {...connectionStatuses[row.original.status]} />
            {!row.original.connectorEnabled ? (
              <Badge label="Connector disabled" variant="warning" />
            ) : null}
          </div>
        ),
      },
      {
        id: "lastUsedAt",
        accessorFn: (row) => (row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0),
        header: "Last used",
        size: 210,
        minSize: 180,
        maxSize: 280,
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            <time className="whitespace-nowrap">
              {dateFormatter.format(new Date(row.original.lastUsedAt))}
            </time>
          ) : (
            <Text color="secondary">Never</Text>
          ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: connections,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <div className="admin-table-action-row">
          <TextInput
            hasClear
            isLabelHidden
            label="Find connections"
            placeholder="Find connections…"
            startIcon="search"
            size="lg"
            width={280}
            value={filters.search}
            onChange={(search) => void setFilters({ search })}
          />
        </div>
      </HerocrumbsActions>
      <div
        className="flex flex-wrap items-center gap-3"
        role="group"
        aria-label="Connection filters"
      >
        <Selector
          hasClear
          isLabelHidden
          label="Status"
          placeholder="All statuses"
          width={220}
          value={filters.status || null}
          options={statusOptions}
          onChange={(status) => void setFilters({ status })}
        />
        <Selector
          hasClear
          isLabelHidden
          label="Connector"
          placeholder="All connectors"
          width={240}
          value={filters.connector || null}
          options={connectorOptions}
          onChange={(connector) => void setFilters({ connector })}
        />
        {hasFilters ? (
          <Button
            label="Clear filters"
            variant="secondary"
            onClick={() => void setFilters({ search: null, status: null, connector: null })}
          />
        ) : null}
      </div>
      <Text color="secondary">
        {connections.length} of {data.length} connections shown. Filters apply to the 200 most
        recent connections.
      </Text>
      {connectionsQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load connections"
          description={connectionsQuery.error.message}
        />
      ) : null}
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
        <div className="w-full overflow-x-auto" role="group" aria-label="Managed connections table">
          <table
            className="admin-resizable-table table-fixed border-collapse text-left"
            style={{ minWidth: "100%", width: table.getTotalSize() }}
          >
            <ResizableTableHeader table={table} />
            <TableBody>
              {table.getRowModel().rows.map((row) => {
                const href = `/admin/connections/${encodeURIComponent(row.original.id)}`;
                return (
                  <TableRow
                    key={row.id}
                    aria-label={`Open ${row.original.name}`}
                    data-clickable="true"
                    onClick={(event) => {
                      if (!isInteractiveTableTarget(event.target, event.currentTarget))
                        router.push(href);
                    }}
                  >
                    {row.getVisibleCells().map((cell, index) => (
                      <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                        {index === 0 ? (
                          <TableRowAction href={href} label={`Open ${row.original.name}`}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableRowAction>
                        ) : (
                          flexRender(cell.column.columnDef.cell, cell.getContext())
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
              {!connectionsQuery.isPending &&
              !connectionsQuery.error &&
              table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">
                      {hasFilters
                        ? "No connections match these filters."
                        : "No managed connections have been created."}
                    </Text>
                  </TableCell>
                </TableRow>
              ) : null}
              {connectionsQuery.isPending ? (
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
    </>
  );
}
