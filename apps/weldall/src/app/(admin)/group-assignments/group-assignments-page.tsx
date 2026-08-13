"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import { ManagementBadge } from "@/components/admin/management-badge";
import type { GroupAssignmentDto } from "@/server/group-providers/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";

const PAGE_SIZE = 20;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function GroupAssignmentsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const operationToast = useOperationToast();
  const [deletingAssignment, setDeletingAssignment] = useState<GroupAssignmentDto | null>(null);
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
  const deleteMutation = useMutation(
    trpc.admin.groupAssignments.delete.mutationOptions({
      onSuccess: async () => {
        setDeletingAssignment(null);
        operationToast.success("Group assignment deleted", "group-assignment-delete");
        await queryClient.invalidateQueries();
      },
      onError: (error) =>
        operationToast.error("Could not delete group assignment", error, "group-assignment-delete"),
    }),
  );
  const assignments = assignmentsQuery.data?.items ?? [];
  const columns = useMemo<ColumnDef<GroupAssignmentDto>[]>(
    () => [
      {
        accessorKey: "providerName",
        header: "Provider",
        cell: ({ row, getValue }) => (
          <div className="grid gap-1">
            <span className="font-medium">{getValue<string>()}</span>
            <code className="text-xs">{row.original.providerKey}</code>
            <ManagementBadge management={row.original.management} />
          </div>
        ),
      },
      {
        accessorKey: "groupName",
        header: "Group",
        cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
      },
      {
        accessorKey: "groupId",
        header: "Group ID",
        cell: ({ getValue }) => <code className="text-sm">{getValue<string>()}</code>,
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        cell: ({ getValue }) => (
          <div className="flex max-w-[44rem] flex-wrap gap-1">
            {getValue<string[]>().map((scope) => (
              <Badge key={scope} label={scope} />
            ))}
          </div>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ getValue }) => (
          <time className="whitespace-nowrap">
            {dateFormatter.format(new Date(getValue<string>()))}
          </time>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end gap-2">
            <Button
              href={`/group-assignments/${row.original.id}`}
              label="Edit"
              size="sm"
              variant="secondary"
            />
            <Button
              label="Delete"
              onClick={() => setDeletingAssignment(row.original)}
              size="sm"
              variant="destructive"
            />
          </div>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: assignments,
    columns,
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
          <Button href="/group-assignments/new" label="Create group assignment" variant="primary" />
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
            dividers: "rows",
            hasHover: false,
            isStriped: false,
            textOverflow: "wrap",
            verticalAlign: "middle",
          }}
        >
          <div className="w-full overflow-x-auto" role="group" aria-label="Group assignments table">
            <table className="w-full min-w-[900px] border-collapse text-left">
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} isHeaderRow>
                    {headerGroup.headers.map((header) => (
                      <TableHeaderCell key={header.id} scope="col">
                        {String(header.column.columnDef.header ?? "")}
                      </TableHeaderCell>
                    ))}
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
      <AlertDialog
        actionLabel="Delete assignment"
        description={
          deletingAssignment
            ? `Remove all group-derived scopes for ${deletingAssignment.groupName} from ${deletingAssignment.providerName}?`
            : "Delete this group assignment?"
        }
        isActionLoading={deleteMutation.isPending}
        isOpen={Boolean(deletingAssignment)}
        onAction={() => {
          if (deletingAssignment) {
            deleteMutation.mutate({
              id: deletingAssignment.id,
              expectedVersion: deletingAssignment.version,
            });
          }
        }}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            deleteMutation.reset();
            setDeletingAssignment(null);
          }
        }}
        title="Delete group assignment?"
      />
    </>
  );
}
