"use client";

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Pagination } from "@astryxdesign/core/Pagination";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { AdminAgentDto, AgentCatalogState } from "@/server/agents/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { OverflowFade, ResizableTableHeader } from "../resizable-table";

const PAGE_SIZE = 200;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const emptyAgents: AdminAgentDto[] = [];
/** The same states and labels as the catalog status of discovered skills (`skills-table.tsx`). */
const catalogStatuses: Record<
  AgentCatalogState,
  {
    icon: "success" | "warning" | "error" | "info";
    color: "success" | "warning" | "error" | "accent";
    label: string;
  }
> = {
  fresh: { icon: "success", color: "success", label: "Fresh" },
  stale: { icon: "warning", color: "warning", label: "Stale" },
  failed: { icon: "error", color: "error", label: "Failed" },
  expired: { icon: "error", color: "error", label: "Expired" },
  pending: { icon: "info", color: "accent", label: "Pending" },
  disabled: { icon: "info", color: "accent", label: "Disabled" },
};

const dateColumn = (
  key: "createdAt" | "updatedAt" | "expiresAt",
  header: string,
): ColumnDef<AdminAgentDto> => ({
  accessorKey: key,
  header,
  size: 190,
  minSize: 150,
  maxSize: 300,
  enableSorting: false,
  cell: ({ getValue }) => (
    <time className="whitespace-nowrap">{dateFormatter.format(new Date(getValue<string>()))}</time>
  ),
});

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
        size: 240,
        minSize: 160,
        maxSize: 420,
        enableSorting: false,
        cell: ({ getValue }) => (
          <OverflowFade title={getValue<string>()}>{getValue<string>()}</OverflowFade>
        ),
      },
      {
        accessorKey: "description",
        header: "Purpose",
        size: 320,
        minSize: 180,
        maxSize: 560,
        enableSorting: false,
        cell: ({ getValue }) => (
          <Text color="secondary" type="supporting">
            {getValue<string>()}
          </Text>
        ),
      },
      {
        id: "owner",
        header: "Shared by",
        size: 200,
        minSize: 140,
        maxSize: 360,
        enableSorting: false,
        cell: ({ row }) => {
          // An owner Weldall does not know is named by the id the resource reported.
          const label = row.original.ownerName ?? `Unknown person (${row.original.ownerId})`;
          return <OverflowFade title={label}>{label}</OverflowFade>;
        },
      },
      {
        accessorKey: "ownerEmail",
        header: "Email",
        size: 240,
        minSize: 160,
        maxSize: 420,
        enableSorting: false,
        cell: ({ getValue }) => {
          const email = getValue<string | null>();
          return email ? (
            <OverflowFade title={email}>{email}</OverflowFade>
          ) : (
            <Text color="secondary">Not known</Text>
          );
        },
      },
      {
        accessorKey: "scopes",
        header: "Shared with holders of any of",
        size: 300,
        minSize: 200,
        maxSize: 560,
        enableSorting: false,
        cell: ({ getValue }) => {
          const scopes = getValue<string[]>();
          if (!scopes.length) return <Text color="secondary">Only its owner</Text>;
          return (
            <div className="flex flex-wrap gap-1">
              {scopes.map((scope) => (
                <Badge key={scope} label={scope} variant="neutral" />
              ))}
            </div>
          );
        },
      },
      {
        id: "resource",
        header: "Resource",
        size: 200,
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
        accessorKey: "catalogState",
        header: "Catalog status",
        size: 170,
        minSize: 150,
        maxSize: 280,
        enableSorting: false,
        cell: ({ getValue }) => {
          const status = catalogStatuses[getValue<AgentCatalogState>()];
          return (
            <HStack gap={2} vAlign="center">
              <Text type="body">{status.label}</Text>
              <Icon icon={status.icon} color={status.color} size="sm" />
            </HStack>
          );
        },
      },
      dateColumn("createdAt", "Created"),
      dateColumn("updatedAt", "Last changed"),
      dateColumn("expiresAt", "Expires"),
      {
        accessorKey: "expired",
        header: "Confirmation",
        size: 150,
        minSize: 120,
        maxSize: 240,
        enableSorting: false,
        cell: ({ getValue }) =>
          getValue<boolean>() ? (
            <Badge label="Expired" variant="warning" />
          ) : (
            <Text color="secondary">Current</Text>
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
