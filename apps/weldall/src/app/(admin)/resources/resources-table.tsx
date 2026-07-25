"use client";

import { useMemo } from "react";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Pagination } from "@astryxdesign/core/Pagination";
import {
  TableBody,
  TableCell,
  TableContext,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { ResourceDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { createSortingParser, resolveUpdater, sortLabel } from "../table-state";

const sortingParser = createSortingParser(new Set(["name", "updatedAt"]), [
  { id: "name", desc: false },
]);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ResourcesTable() {
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
        cell: ({ row, getValue }) => (
          <div className="grid gap-1">
            <span className="font-medium">{getValue<string>()}</span>
            <code className="text-xs">{row.original.key}</code>
          </div>
        ),
      },
      {
        accessorKey: "resourceIdentifier",
        header: "Resource identifier",
        enableSorting: false,
        cell: ({ getValue }) => <code className="text-sm">{getValue<string>()}</code>,
      },
      {
        accessorKey: "enabled",
        header: "Status",
        enableSorting: false,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Enabled" : "Disabled"}
            variant={getValue<boolean>() ? "neutral" : "purple"}
          />
        ),
      },
      {
        accessorKey: "scopeIds",
        header: "Scopes",
        enableSorting: false,
        cell: ({ getValue }) => getValue<string[]>().length.toLocaleString(),
      },
      {
        accessorKey: "requestPrefixes",
        header: "Prefixes",
        enableSorting: false,
        cell: ({ getValue }) => getValue<string[]>().length.toLocaleString(),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ getValue }) => dateFormatter.format(new Date(getValue<string>())),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              href={`/resources/${row.original.id}`}
              label="Open"
              size="sm"
              variant="secondary"
            />
          </div>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: resources,
    columns,
    state: { sorting },
    manualSorting: true,
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
          <Button href="/resources/new" label="Create resource" variant="primary" />
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
            dividers: "rows",
            hasHover: false,
            isStriped: false,
            textOverflow: "wrap",
            verticalAlign: "middle",
          }}
        >
          <div className="w-full overflow-x-auto" role="group" aria-label="Resources table">
            <table className="w-full min-w-[980px] border-collapse text-left">
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} isHeaderRow>
                    {headerGroup.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      const label = String(header.column.columnDef.header ?? "");
                      return (
                        <TableHeaderCell
                          key={header.id}
                          scope="col"
                          aria-sort={
                            sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined
                          }
                        >
                          {header.column.getCanSort() ? (
                            <button
                              className="w-full border-0 bg-transparent p-0 text-left font-[inherit] text-inherit"
                              onClick={header.column.getToggleSortingHandler()}
                              type="button"
                            >
                              {sortLabel(label, sorted)}
                            </button>
                          ) : (
                            label
                          )}
                        </TableHeaderCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
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
  return `${first.id}.${first.desc ? "desc" : "asc"}` as
    "name.asc" | "name.desc" | "updatedAt.asc" | "updatedAt.desc";
}
