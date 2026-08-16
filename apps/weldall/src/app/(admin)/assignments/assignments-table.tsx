"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Pagination } from "@astryxdesign/core/Pagination";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import { ManagementBadge } from "@/components/admin/management-badge";
import type { AssignmentDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";
import { createSortingParser, resolveUpdater } from "../table-state";
import { ScopeBadges } from "./scope-badges";

const sortingParser = createSortingParser(new Set(["email", "updatedAt"]), [
  { id: "email", desc: false },
]);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function AssignmentsTable() {
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
  const assignmentsQuery = useQuery(
    trpc.admin.assignments.list.queryOptions({
      page,
      pageSize: 20,
      q,
      sort: sortingToAssignmentSort(sorting),
    }),
  );
  const assignments = assignmentsQuery.data?.items ?? [];

  const columns = useMemo<ColumnDef<AssignmentDto>[]>(
    () => [
      {
        accessorKey: "email",
        header: "Email",
        size: 480,
        minSize: 220,
        maxSize: 720,
        cell: ({ row, getValue }) => {
          const email = getValue<string>();
          return (
            <OverflowFade title={email}>
              <div className="flex w-max flex-nowrap items-center gap-2 whitespace-nowrap">
                <span>{email}</span>
                <ManagementBadge management={row.original.management} />
              </div>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        size: 620,
        minSize: 240,
        maxSize: 900,
        enableSorting: false,
        cell: ({ getValue }) => {
          const scopes = getValue<string[]>();
          return (
            <OverflowFade title={scopes.join(", ")}>
              <ScopeBadges scopes={scopes} />
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        size: 300,
        minSize: 220,
        maxSize: 420,
        cell: ({ getValue }) => (
          <time className="whitespace-nowrap">
            {dateFormatter.format(new Date(getValue<string>()))}
          </time>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({
    data: assignments,
    columns,
    state: { sorting },
    manualSorting: true,
    columnResizeMode: "onChange",
    onSortingChange: (updater: Updater<SortingState>) => {
      const next = resolveUpdater(updater, sorting);
      void setTableQuery({ sort: next, page: 1 });
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
            label="Find email assignments"
            onChange={(value) => void setTableQuery({ q: value || null, page: 1 })}
            placeholder="Find email…"
            size="lg"
            startIcon="search"
            value={q}
            width={260}
          />
          <Button href="/assignments/new" label="Create assignment" variant="primary" />
        </div>
      </HerocrumbsActions>

      {assignmentsQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load assignments"
          description={assignmentsQuery.error.message}
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
          <div className="w-full overflow-x-auto" role="group" aria-label="Email assignments table">
            <table
              className="admin-resizable-table table-fixed border-collapse text-left"
              style={{ minWidth: "100%", width: table.getTotalSize() }}
            >
              <ResizableTableHeader table={table} />
              <TableBody>
                {table.getRowModel().rows.map((row) => {
                  const href = `/assignments/${row.original.id}`;
                  return (
                    <TableRow
                      key={row.id}
                      aria-label={`Edit ${row.original.email}`}
                      data-clickable="true"
                      onClick={(event) => {
                        if (isInteractiveTableTarget(event.target, event.currentTarget)) return;
                        router.push(href);
                      }}
                    >
                      {row.getVisibleCells().map((cell, index) => (
                        <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                          {index === 0 ? (
                            <TableRowAction href={href} label={`Edit ${row.original.email}`}>
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
                {!assignmentsQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q
                          ? "No email assignments match this search."
                          : "No email assignments have been created."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {assignmentsQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading assignments…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="Assignment pages"
            onChange={(nextPage) => void setTableQuery({ page: nextPage })}
            page={page}
            pageSize={20}
            totalItems={assignmentsQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>
    </>
  );
}

function sortingToAssignmentSort(sorting: SortingState) {
  const first = sorting[0] ?? { id: "email", desc: false };
  return `${first.id}.${first.desc ? "desc" : "asc"}` as
    "email.asc" | "email.desc" | "updatedAt.asc" | "updatedAt.desc";
}
