"use client";

import { useMemo, useState } from "react";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
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
import type { AssignmentDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";
import { createSortingParser, resolveUpdater, sortLabel } from "../table-state";
import { ScopeBadges } from "./scope-badges";

const sortingParser = createSortingParser(new Set(["email", "updatedAt"]), [
  { id: "email", desc: false },
]);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function AssignmentsTable() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [deletingAssignment, setDeletingAssignment] = useState<AssignmentDto | null>(null);
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
        cell: ({ row, getValue }) => (
          <div className="grid gap-1">
            <span className="font-medium">{getValue<string>()}</span>
            <ManagementBadge management={row.original.management} />
          </div>
        ),
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        enableSorting: false,
        cell: ({ getValue }) => <ScopeBadges scopes={getValue<string[]>()} />,
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
          <div className="flex justify-end gap-2">
            <Button
              href={`/assignments/${row.original.id}`}
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
    state: { sorting },
    manualSorting: true,
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
            dividers: "rows",
            hasHover: false,
            isStriped: false,
            textOverflow: "wrap",
            verticalAlign: "middle",
          }}
        >
          <div className="w-full overflow-x-auto" role="group" aria-label="Email assignments table">
            <table className="w-full min-w-[760px] border-collapse text-left">
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

      <DeleteAssignmentDialog
        assignment={deletingAssignment}
        onClose={() => setDeletingAssignment(null)}
        onDeleted={async () => {
          setDeletingAssignment(null);
          await queryClient.invalidateQueries();
        }}
      />
    </>
  );
}

function DeleteAssignmentDialog({
  assignment,
  onClose,
  onDeleted,
}: {
  assignment: AssignmentDto | null;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const operationToast = useOperationToast();
  const mutation = useMutation(
    trpc.admin.assignments.delete.mutationOptions({
      onSuccess: () => {
        operationToast.success("Assignment deleted", "assignment-delete");
        void onDeleted();
      },
      onError: (error) =>
        operationToast.error("Could not delete assignment", error, "assignment-delete"),
    }),
  );
  const removesAdmin = assignment?.scopes.includes("weldall:administer") ?? false;
  return (
    <AlertDialog
      actionLabel="Delete assignment"
      description={
        assignment
          ? `Remove all scopes from ${assignment.email}?${removesAdmin ? " This also removes administrator access and is rejected for the final administrator." : ""}`
          : "Delete this assignment?"
      }
      isActionLoading={mutation.isPending}
      isOpen={Boolean(assignment)}
      onAction={() => {
        if (assignment) {
          mutation.mutate({ id: assignment.id, expectedVersion: assignment.version });
        }
      }}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          mutation.reset();
          onClose();
        }
      }}
      title="Delete assignment?"
    />
  );
}

function sortingToAssignmentSort(sorting: SortingState) {
  const first = sorting[0] ?? { id: "email", desc: false };
  return `${first.id}.${first.desc ? "desc" : "asc"}` as
    "email.asc" | "email.desc" | "updatedAt.asc" | "updatedAt.desc";
}
