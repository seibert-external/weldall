"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
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
import type { GroupAssignmentDto } from "@/server/group-providers/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";

const PAGE_SIZE = 20;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function GroupAssignmentsPage() {
  const router = useRouter();
  const trpc = useTRPC();
  const [{ q, page }, setTableQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      page: parseAsInteger.withDefault(1),
    },
    { history: "replace", shallow: true },
  );
  const currentPage = Math.max(1, page);
  const assignmentsQuery = useQuery(
    trpc.admin.groupAssignments.list.queryOptions({ page: currentPage, pageSize: PAGE_SIZE, q }),
  );
  const total = assignmentsQuery.data?.total;
  useEffect(() => {
    if (total === undefined) return;
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const validPage = Math.min(currentPage, lastPage);
    if (page !== validPage) void setTableQuery({ page: validPage });
  }, [currentPage, page, setTableQuery, total]);
  const assignments = assignmentsQuery.data?.items ?? [];
  const columns = useMemo<ColumnDef<GroupAssignmentDto>[]>(
    () => [
      {
        accessorKey: "providerName",
        header: "Provider",
        size: 380,
        minSize: 200,
        maxSize: 560,
        cell: ({ row, getValue }) => {
          const providerName = getValue<string>();
          return (
            <OverflowFade title={`${providerName} (${row.original.providerKey})`}>
              <div className="flex w-max flex-nowrap items-center gap-2 whitespace-nowrap">
                <span>{providerName}</span>
                <code className="text-xs">{row.original.providerKey}</code>
                <ManagementBadge management={row.original.management} />
              </div>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "groupId",
        header: "Group ID",
        size: 320,
        minSize: 180,
        maxSize: 520,
        cell: ({ getValue }) => {
          const groupId = getValue<string>();
          return (
            <OverflowFade title={groupId}>
              <code className="whitespace-nowrap text-sm">{groupId}</code>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        size: 430,
        minSize: 220,
        maxSize: 760,
        cell: ({ getValue }) => {
          const scopes = getValue<string[]>();
          return (
            <OverflowFade title={scopes.join(", ")}>
              <div className="flex w-max flex-nowrap gap-1 whitespace-nowrap">
                {scopes.map((scope) => (
                  <Badge key={scope} label={scope} />
                ))}
              </div>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        size: 270,
        minSize: 220,
        maxSize: 400,
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
    enableSorting: false,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <div className="admin-table-action-row">
          <TextInput
            hasClear
            isLabelHidden
            label="Find group assignments"
            onChange={(value) => void setTableQuery({ q: value || null, page: 1 })}
            placeholder="Find groups or providers…"
            size="lg"
            startIcon="search"
            value={q}
            width={280}
          />
          <Button
            href="/admin/group-assignments/new"
            label="Create group assignment"
            variant="primary"
          />
        </div>
      </HerocrumbsActions>
      {assignmentsQuery.error ? (
        <Banner
          container="card"
          description={assignmentsQuery.error.message}
          status="error"
          title="Could not load group assignments"
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
          <div className="w-full overflow-x-auto" role="group" aria-label="Group assignments table">
            <table
              className="admin-resizable-table table-fixed border-collapse text-left"
              style={{ minWidth: "100%", width: table.getTotalSize() }}
            >
              <ResizableTableHeader table={table} />
              <TableBody>
                {table.getRowModel().rows.map((row) => {
                  const href = `/admin/group-assignments/${row.original.id}`;
                  return (
                    <TableRow
                      key={row.id}
                      aria-label={`Edit ${row.original.groupId}`}
                      data-clickable="true"
                      onClick={(event) => {
                        if (isInteractiveTableTarget(event.target, event.currentTarget)) return;
                        router.push(href);
                      }}
                    >
                      {row.getVisibleCells().map((cell, index) => (
                        <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                          {index === 0 ? (
                            <TableRowAction href={href} label={`Edit ${row.original.groupId}`}>
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
                {!assignmentsQuery.isPending &&
                !assignmentsQuery.error &&
                table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q
                          ? "No group assignments match this search."
                          : "No group assignments have been created."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {assignmentsQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading group assignments…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="Group assignment pages"
            onChange={(nextPage) => void setTableQuery({ page: nextPage })}
            page={currentPage}
            pageSize={PAGE_SIZE}
            totalItems={assignmentsQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>
    </>
  );
}
