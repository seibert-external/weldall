"use client";

import { useId, useMemo, useState } from "react";
import type { AnyFieldApi } from "@tanstack/react-form";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
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
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { AssignmentDto, ScopeDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { createSortingParser, resolveUpdater, sortLabel } from "../table-state";

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
  const [editingAssignment, setEditingAssignment] = useState<AssignmentDto | null | undefined>(
    undefined,
  );
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
  const scopeOptionsQuery = useQuery(trpc.admin.scopes.options.queryOptions());
  const assignments = assignmentsQuery.data?.items ?? [];

  const columns = useMemo<ColumnDef<AssignmentDto>[]>(
    () => [
      {
        accessorKey: "email",
        header: "Email",
        cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        enableSorting: false,
        cell: ({ getValue }) => (
          <div className="flex max-w-[44rem] flex-wrap gap-1">
            {getValue<string[]>().map((scope) => (
              <Badge
                key={scope}
                label={scope}
                variant={scope === "weldall:administer" ? "purple" : "neutral"}
              />
            ))}
          </div>
        ),
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
              label="Edit"
              onClick={() => setEditingAssignment(row.original)}
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
          <Button
            isDisabled={scopeOptionsQuery.isPending || Boolean(scopeOptionsQuery.error)}
            label="Create assignment"
            onClick={() => setEditingAssignment(null)}
            variant="primary"
          />
        </div>
      </HerocrumbsActions>

      {assignmentsQuery.error || scopeOptionsQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load assignments"
          description={(assignmentsQuery.error ?? scopeOptionsQuery.error)?.message}
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

      {editingAssignment !== undefined ? (
        <AssignmentDialog
          key={editingAssignment?.id ?? "new"}
          assignment={editingAssignment}
          scopes={scopeOptionsQuery.data ?? []}
          onClose={() => setEditingAssignment(undefined)}
          onSaved={async () => {
            setEditingAssignment(undefined);
            await queryClient.invalidateQueries();
          }}
        />
      ) : null}
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

function AssignmentDialog({
  assignment,
  scopes,
  onClose,
  onSaved,
}: {
  assignment: AssignmentDto | null;
  scopes: Pick<ScopeDto, "id" | "key" | "description" | "isSystem">[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const formId = useId();
  const mutation = useMutation(trpc.admin.assignments.replace.mutationOptions());
  const form = useForm({
    defaultValues: {
      email: assignment?.email ?? "",
      scopeKeys: assignment?.scopes ?? ([] as string[]),
    },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync({
        email: value.email.trim(),
        scopeKeys: value.scopeKeys,
        expectedVersion: assignment?.version ?? null,
      });
      await onSaved();
    },
  });
  const changeOpen = (open: boolean) => {
    if (!open && !mutation.isPending) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={changeOpen} purpose="form" width="min(680px, calc(100vw - 32px))">
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={changeOpen}
            subtitle="Assignments may be created before a user signs in. Saving replaces the complete scope set."
            title={assignment ? "Edit assignment" : "Create assignment"}
          />
        }
        content={
          <LayoutContent>
            <form
              className="admin-dialog-form"
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
              }}
            >
              {mutation.error ? (
                <Banner
                  container="card"
                  status="error"
                  title="Could not save assignment"
                  description={mutation.error.message}
                />
              ) : null}
              <FormLayout>
                <form.Field
                  name="email"
                  validators={{
                    onBlur: ({ value }) => validateEmail(value),
                    onChange: ({ value }) => validateEmail(value),
                    onSubmit: ({ value }) => validateEmail(value),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isDisabled={Boolean(assignment)}
                      isRequired
                      label="Email address"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="person@example.com"
                      {...fieldStatusProps(field)}
                      type="email"
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="scopeKeys"
                  validators={{
                    onSubmit: ({ value }) =>
                      !assignment && value.length === 0 ? "Choose at least one scope." : undefined,
                  }}
                >
                  {(field) => (
                    <MultiSelector
                      hasClear
                      hasSearch
                      hasSelectAll
                      isRequired={!assignment}
                      label="Scopes"
                      onChange={field.handleChange}
                      options={scopes.map((scope) => ({
                        value: scope.key,
                        label: scope.key,
                      }))}
                      placeholder="Choose scopes…"
                      renderOption={(option) => {
                        const selectedScope = scopes.find((scope) => scope.key === option.value);
                        return (
                          <div className="grid gap-0.5">
                            <span>{option.label ?? option.value}</span>
                            {selectedScope ? (
                              <span className="text-xs text-[var(--color-text-secondary)]">
                                {selectedScope.description}
                              </span>
                            ) : null}
                          </div>
                        );
                      }}
                      searchPlaceholder="Find scopes…"
                      {...fieldStatusProps(field)}
                      triggerDisplay="badges"
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
                {assignment?.scopes.includes("weldall:administer") ? (
                  <form.Subscribe selector={(state) => state.values.scopeKeys}>
                    {(scopeKeys) =>
                      scopeKeys.includes("weldall:administer") ? null : (
                        <Banner
                          container="card"
                          status="warning"
                          title="Administrator access will be removed"
                          description="The server rejects this change if it would remove the final administrator."
                        />
                      )
                    }
                  </form.Subscribe>
                ) : null}
              </FormLayout>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex justify-end gap-2">
              <Button label="Cancel" onClick={onClose} type="button" variant="secondary" />
              <form.Subscribe selector={(state) => state.canSubmit}>
                {(canSubmit) => (
                  <Button
                    form={formId}
                    isDisabled={!canSubmit}
                    isLoading={mutation.isPending}
                    label="Save assignment"
                    type="submit"
                    variant="primary"
                  />
                )}
              </form.Subscribe>
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
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
  const mutation = useMutation(
    trpc.admin.assignments.delete.mutationOptions({
      onSuccess: () => void onDeleted(),
    }),
  );
  const removesAdmin = assignment?.scopes.includes("weldall:administer") ?? false;
  return (
    <AlertDialog
      actionLabel="Delete assignment"
      description={
        mutation.error
          ? mutation.error.message
          : assignment
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

function validateEmail(value: unknown): string | undefined {
  const email = String(value).trim();
  if (!email) return "Email address is required.";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? undefined : "Enter a valid email address.";
}

function fieldStatusProps(field: AnyFieldApi) {
  const status = fieldStatus(field);
  return status ? { status } : {};
}

function fieldStatus(field: AnyFieldApi): { type: "error"; message: string } | undefined {
  const messages = field.state.meta.errors
    .map(errorMessage)
    .filter((message): message is string => Boolean(message));
  return field.state.meta.isValid || messages.length === 0
    ? undefined
    : { type: "error", message: messages.join(", ") };
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return typeof error.message === "string" ? error.message : undefined;
  }
  return undefined;
}
