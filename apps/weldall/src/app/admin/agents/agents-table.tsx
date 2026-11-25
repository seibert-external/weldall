"use client";

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Layout";
import { Pagination } from "@astryxdesign/core/Pagination";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { AdminAgentDto } from "@/server/agents/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { OverflowFade, ResizableTableHeader } from "../resizable-table";

const PAGE_SIZE = 200;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const emptyAgents: AdminAgentDto[] = [];

/**
 * The agents Weldall discovered from resources: who shared what with whom. Read-only, and without
 * the agents' instructions; people change or delete an agent where they keep it.
 */
export function AgentsTable() {
  const trpc = useTRPC();
  const [{ q, source, page }, setTableQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      source: parseAsString.withDefault(""),
      page: parseAsInteger.withDefault(1),
    },
    { history: "replace", shallow: true },
  );
  const agentsQuery = useQuery(
    trpc.admin.agents.list.queryOptions({
      page,
      pageSize: PAGE_SIZE,
      q,
      ...(source ? { source } : {}),
    }),
  );
  const agents = agentsQuery.data?.items ?? emptyAgents;
  const columns = useMemo<ColumnDef<AdminAgentDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Agent",
        size: 360,
        minSize: 200,
        maxSize: 560,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col">
            <OverflowFade title={row.original.name}>{row.original.name}</OverflowFade>
            <Text color="secondary" type="supporting">
              {row.original.description}
            </Text>
          </div>
        ),
      },
      {
        id: "owner",
        header: "Shared by",
        size: 300,
        minSize: 180,
        maxSize: 460,
        enableSorting: false,
        cell: ({ row }) => {
          const label = row.original.ownerName
            ? `${row.original.ownerName} (${row.original.ownerEmail})`
            : `Unknown person (${row.original.ownerId})`;
          return <OverflowFade title={label}>{label}</OverflowFade>;
        },
      },
      {
        accessorKey: "scopes",
        header: "Shared with holders of any of",
        size: 340,
        minSize: 200,
        maxSize: 560,
        enableSorting: false,
        cell: ({ getValue }) => (
          <div className="flex flex-wrap gap-1">
            {getValue<string[]>().map((scope) => (
              <Badge key={scope} label={scope} variant="neutral" />
            ))}
          </div>
        ),
      },
      {
        id: "resource",
        header: "Resource",
        size: 220,
        minSize: 140,
        maxSize: 320,
        enableSorting: false,
        cell: ({ row }) => (
          <OverflowFade title={row.original.resource.name}>
            {row.original.resource.name}
          </OverflowFade>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Last changed",
        size: 260,
        minSize: 180,
        maxSize: 340,
        enableSorting: false,
        cell: ({ row, getValue }) => (
          <HStack gap={2} vAlign="center">
            <time className="whitespace-nowrap">
              {dateFormatter.format(new Date(getValue<string>()))}
            </time>
            {row.original.expired ? <Badge label="Expired" variant="warning" /> : null}
          </HStack>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: agents,
    columns,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
  });
  const sourceName = source ? agents[0]?.resource.name : undefined;

  return (
    <>
      <HerocrumbsActions>
        {source ? (
          <Button
            label={sourceName ? `Only ${sourceName}: show all` : "Show all resources"}
            onClick={() => void setTableQuery({ source: null, page: 1 })}
            type="button"
            variant="secondary"
          />
        ) : null}
        <TextInput
          hasClear
          isLabelHidden
          label="Find agents"
          onChange={(value) => void setTableQuery({ q: value || null, page: 1 })}
          placeholder="Find agents…"
          size="lg"
          startIcon="search"
          value={q}
          width={280}
        />
      </HerocrumbsActions>
      {agentsQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load agents"
          description={agentsQuery.error.message}
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
          <div className="w-full overflow-x-auto" role="group" aria-label="Shared agents table">
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
                {!agentsQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q
                          ? "No shared agents match this search."
                          : "No shared agents were discovered. A resource publishes them once “Discover agents from this resource” is on."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {agentsQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading agents…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="Agent pages"
            onChange={(nextPage) => void setTableQuery({ page: nextPage })}
            page={page}
            pageSize={PAGE_SIZE}
            totalItems={agentsQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>
    </>
  );
}
