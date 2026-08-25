"use client";

import { useMemo } from "react";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
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
import { ManagementBadge } from "@/components/admin/management-badge";
import type { ResourceDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";
import { createSortingParser, resolveUpdater } from "../table-state";

const sortingParser = createSortingParser(new Set(["name"]), [{ id: "name", desc: false }]);
const discoveryStatuses = {
  fresh: { icon: "success", color: "success", label: "Fresh" },
  stale: { icon: "warning", color: "warning", label: "Stale" },
  failed: { icon: "error", color: "error", label: "Failed" },
  expired: { icon: "error", color: "error", label: "Expired" },
  pending: { icon: "info", color: "accent", label: "Pending" },
  disabled: { icon: "info", color: "accent", label: "Disabled" },
} as const;

export function ResourcesTable() {
  const router = useRouter();
  const trpc = useTRPC();
  const [{ q, page, sort: sorting }, setTableQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      page: parseAsInteger.withDefault(1),
      sort: sortingParser,
    },
    { history: "replace", shallow: true },
  );
  const resourcesQuery = useQuery(
    trpc.admin.resources.list.queryOptions({
      page,
      pageSize: 20,
      q,
      sort: sortingToResourceSort(sorting),
    }),
  );
  const resources = resourcesQuery.data?.items ?? [];
  const columns = useMemo<ColumnDef<ResourceDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        size: 340,
        minSize: 140,
        maxSize: 360,
        cell: ({ row, getValue }) => {
          const name = getValue<string>();
          return (
            <OverflowFade title={name}>
              <div className="flex w-max items-center gap-2 whitespace-nowrap">
                <span>{name}</span>
                <ManagementBadge management={row.original.management} />
              </div>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "key",
        header: "ID",
        size: 240,
        minSize: 110,
        maxSize: 300,
        enableSorting: false,
        cell: ({ getValue }) => {
          const id = getValue<string>();
          return (
            <OverflowFade title={id}>
              <code className="whitespace-nowrap text-sm">{id}</code>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "resourceIdentifier",
        header: "Resource identifier",
        size: 440,
        minSize: 160,
        maxSize: 520,
        enableSorting: false,
        cell: ({ getValue }) => {
          const resourceIdentifier = getValue<string>();
          return (
            <OverflowFade title={resourceIdentifier}>
              <code className="whitespace-nowrap text-sm">{resourceIdentifier}</code>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "enabled",
        header: "Status",
        size: 140,
        minSize: 100,
        maxSize: 160,
        enableSorting: false,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Enabled" : "Disabled"}
            variant={getValue<boolean>() ? "neutral" : "purple"}
          />
        ),
      },
      {
        accessorKey: "skillDiscoveryEnabled",
        header: "Skill discovery",
        size: 240,
        minSize: 140,
        maxSize: 240,
        enableSorting: false,
        cell: ({ row, getValue }) => {
          const state = getValue<boolean>()
            ? (row.original.catalogStatus?.state ?? "pending")
            : "disabled";
          const status = discoveryStatuses[state];
          return (
            <HStack gap={2} vAlign="center">
              <Text type="body">
                {status.label} ({row.original.catalogStatus?.skillCount ?? 0})
              </Text>
              <Icon icon={status.icon} color={status.color} size="sm" />
            </HStack>
          );
        },
      },
    ],
    [],
  );
  const table = useReactTable({
    data: resources,
    columns,
    state: { sorting },
    manualSorting: true,
    columnResizeMode: "onChange",
    onSortingChange: (updater: Updater<SortingState>) => {
      void setTableQuery({ sort: resolveUpdater(updater, sorting), page: 1 });
    },
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <div className="admin-table-action-row">
          <TextInput
            hasClear
            isLabelHidden
            label="Find resources"
            onChange={(value) => void setTableQuery({ q: value || null, page: 1 })}
            placeholder="Find resources…"
            size="lg"
            startIcon="search"
            value={q}
            width={280}
          />
          <Button href="/admin/resources/new" label="Create resource" variant="primary" />
        </div>
      </HerocrumbsActions>
      {resourcesQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load resources"
          description={resourcesQuery.error.message}
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
          <div className="w-full overflow-x-auto" role="group" aria-label="Resources table">
            <table
              className="admin-resizable-table table-fixed border-collapse text-left"
              style={{ minWidth: "100%", width: table.getTotalSize() }}
            >
              <ResizableTableHeader table={table} />
              <TableBody>
                {table.getRowModel().rows.map((row) => {
                  const href = `/admin/resources/${row.original.id}`;
                  return (
                    <TableRow
                      key={row.id}
                      aria-label={`Open ${row.original.name}`}
                      data-clickable="true"
                      onClick={(event) => {
                        if (isInteractiveTableTarget(event.target, event.currentTarget)) return;
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
                {!resourcesQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q ? "No resources match this search." : "No resources have been created."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {resourcesQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading resources…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="Resource pages"
            onChange={(nextPage) => void setTableQuery({ page: nextPage })}
            page={page}
            pageSize={20}
            totalItems={resourcesQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>
    </>
  );
}

function sortingToResourceSort(sorting: SortingState) {
  const first = sorting[0] ?? { id: "name", desc: false };
  return `${first.id}.${first.desc ? "desc" : "asc"}` as "name.asc" | "name.desc";
}
