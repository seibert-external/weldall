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
import { Pagination } from "@astryxdesign/core/Pagination";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import { ManagementBadge } from "@/components/admin/management-badge";
import type { ScopeDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";
import { isInteractiveTableTarget, OverflowFade, ResizableTableHeader, TableRowAction } from "../resizable-table";
import { createSortingParser, resolveUpdater } from "../table-state";

const sortingParser = createSortingParser(new Set(["key", "updatedAt"]), [
  { id: "key", desc: false },
]);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ScopesTable() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [editingScope, setEditingScope] = useState<ScopeDto | null | undefined>(undefined);
  const [deletingScope, setDeletingScope] = useState<ScopeDto | null>(null);
  const [{ q, page, sort: sorting }, setTableQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      page: parseAsInteger.withDefault(1),
      sort: sortingParser,
    },
    { history: "replace", shallow: true },
  );
  const sort = sortingToScopeSort(sorting);
  const scopesQuery = useQuery(
    trpc.admin.scopes.list.queryOptions({ page, pageSize: 20, q, sort }),
  );
  const scopes = scopesQuery.data?.items ?? [];

  const columns = useMemo<ColumnDef<ScopeDto>[]>(
    () => [
      {
        accessorKey: "key",
        header: "Scope key",
        size: 380,
        minSize: 180,
        maxSize: 600,
        cell: ({ row, getValue }) => {
          const key = getValue<string>();
          return (
            <OverflowFade title={key}>
              <div className="flex w-max flex-nowrap items-center gap-2 whitespace-nowrap">
                <code className="text-sm">{key}</code>
                {row.original.isSystem ? <Badge label="System" variant="purple" /> : null}
                <ManagementBadge management={row.original.management} />
              </div>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "description",
        header: "Description",
        size: 600,
        minSize: 220,
        maxSize: 900,
        enableSorting: false,
        cell: ({ getValue }) => {
          const description = getValue<string>();
          return <OverflowFade title={description}>{description}</OverflowFade>;
        },
      },
      {
        accessorKey: "assignmentCount",
        header: "Assignments",
        size: 160,
        minSize: 130,
        maxSize: 220,
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue<number>().toLocaleString()}</span>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        size: 260,
        minSize: 200,
        maxSize: 360,
        cell: ({ getValue }) => (
          <time className="whitespace-nowrap">
            {dateFormatter.format(new Date(getValue<string>()))}
          </time>
        ),
      },
    ],
    [],
  );

  // TanStack Table owns its internal row-model memoization.
  const table = useReactTable({
    data: scopes,
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
            label="Find scopes"
            onChange={(value) => void setTableQuery({ q: value || null, page: 1 })}
            placeholder="Find scopes…"
            size="lg"
            startIcon="search"
            value={q}
            width={260}
          />
          <Button label="Create scope" onClick={() => setEditingScope(null)} variant="primary" />
        </div>
      </HerocrumbsActions>

      {scopesQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load scopes"
          description={scopesQuery.error.message}
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
          <div className="w-full overflow-x-auto" role="group" aria-label="Scopes table">
            <table
              className="admin-resizable-table table-fixed border-collapse text-left"
              style={{ minWidth: "100%", width: table.getTotalSize() }}
            >
              <ResizableTableHeader table={table} />
              <TableBody>
                {table.getRowModel().rows.map((row) => {
                  const isEditable = !row.original.isSystem;
                  return (
                    <TableRow
                      key={row.id}
                      aria-label={isEditable ? `Edit ${row.original.key}` : undefined}
                      data-clickable={isEditable ? "true" : undefined}
                      onClick={
                        isEditable
                          ? (event) => {
                              if (isInteractiveTableTarget(event.target, event.currentTarget))
                                return;
                              setEditingScope(row.original);
                            }
                          : undefined
                      }
                    >
                      {row.getVisibleCells().map((cell, index) => (
                        <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                          {index === 0 && isEditable ? (
                            <TableRowAction
                              label={`Edit ${row.original.key}`}
                              onActivate={() => setEditingScope(row.original)}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableRowAction>
                          ) : flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
                {!scopesQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q ? "No scopes match this search." : "No scopes have been created."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {scopesQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading scopes…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="Scope pages"
            onChange={(nextPage) => void setTableQuery({ page: nextPage })}
            page={page}
            pageSize={20}
            totalItems={scopesQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>

      {editingScope !== undefined ? (
        <ScopeDialog
          key={editingScope?.id ?? "new"}
          scope={editingScope}
          onClose={() => setEditingScope(undefined)}
          onDelete={setDeletingScope}
          onSaved={async () => {
            setEditingScope(undefined);
            await queryClient.invalidateQueries();
          }}
        />
      ) : null}
      <DeleteScopeDialog
        scope={deletingScope}
        onClose={() => setDeletingScope(null)}
        onDeleted={async () => {
          setDeletingScope(null);
          setEditingScope(undefined);
          await queryClient.invalidateQueries();
        }}
      />
    </>
  );
}

function ScopeDialog({
  scope,
  onClose,
  onDelete,
  onSaved,
}: {
  scope: ScopeDto | null;
  onClose: () => void;
  onDelete: (scope: ScopeDto) => void;
  onSaved: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const formId = useId();
  const operationToast = useOperationToast();
  const createMutation = useMutation(
    trpc.admin.scopes.create.mutationOptions({
      onSuccess: () => operationToast.success("Scope created", "scope-save"),
      onError: (error) => operationToast.error("Could not create scope", error, "scope-save"),
    }),
  );
  const updateMutation = useMutation(
    trpc.admin.scopes.update.mutationOptions({
      onSuccess: () => operationToast.success("Scope saved", "scope-save"),
      onError: (error) => operationToast.error("Could not save scope", error, "scope-save"),
    }),
  );
  const mutation = scope ? updateMutation : createMutation;
  const form = useForm({
    defaultValues: {
      key: scope?.key ?? "",
      description: scope?.description ?? "",
    },
    onSubmit: async ({ value }) => {
      if (scope) {
        await updateMutation.mutateAsync({
          id: scope.id,
          description: value.description.trim(),
          expectedVersion: scope.version,
        });
      } else {
        await createMutation.mutateAsync({
          key: value.key.trim(),
          description: value.description.trim(),
        });
      }
      await onSaved();
    },
  });
  const changeOpen = (open: boolean) => {
    if (!open && !mutation.isPending) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={changeOpen} purpose="form" width="min(620px, calc(100vw - 32px))">
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={changeOpen}
            subtitle={
              scope
                ? "The key is immutable because assignments and API policies reference it."
                : "Create a globally unique permission. Resource registration remains separate."
            }
            title={scope ? "Edit scope" : "Create scope"}
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
              <FormLayout>
                <form.Field
                  name="key"
                  validators={{
                    onBlur: ({ value }) => validateScopeKey(value),
                    onChange: ({ value }) => validateScopeKey(value),
                    onSubmit: ({ value }) => validateScopeKey(value),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isDisabled={Boolean(scope)}
                      isRequired
                      label="Scope key"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="namespace:permission"
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="description"
                  validators={{
                    onBlur: ({ value }) => validateDescription(value),
                    onSubmit: ({ value }) => validateDescription(value),
                  }}
                >
                  {(field) => (
                    <TextArea
                      isRequired
                      label="Description"
                      maxLength={500}
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="What does this scope allow?"
                      rows={4}
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                    />
                  )}
                </form.Field>
              </FormLayout>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex items-center justify-end gap-2">
              {scope ? (
                <Button
                  className="mr-auto"
                  label="Delete scope"
                  onClick={() => onDelete(scope)}
                  type="button"
                  variant="destructive"
                />
              ) : null}
              <Button label="Cancel" onClick={onClose} type="button" variant="secondary" />
              <form.Subscribe selector={(state) => state.canSubmit}>
                {(canSubmit) => (
                  <Button
                    form={formId}
                    isDisabled={!canSubmit}
                    isLoading={mutation.isPending}
                    label={scope ? "Save scope" : "Create scope"}
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

function DeleteScopeDialog({
  scope,
  onClose,
  onDeleted,
}: {
  scope: ScopeDto | null;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const operationToast = useOperationToast();
  const mutation = useMutation(
    trpc.admin.scopes.delete.mutationOptions({
      onSuccess: () => {
        operationToast.success("Scope deleted", "scope-delete");
        void onDeleted();
      },
      onError: (error) => operationToast.error("Could not delete scope", error, "scope-delete"),
    }),
  );
  return (
    <AlertDialog
      actionLabel="Delete scope"
      description={
        scope
          ? `Delete ${scope.key}? This atomically removes it from ${scope.assignmentCount.toLocaleString()} assignment${scope.assignmentCount === 1 ? "" : "s"}. This cannot be undone.`
          : "Delete this scope?"
      }
      isActionLoading={mutation.isPending}
      isOpen={Boolean(scope)}
      onAction={() => {
        if (scope) mutation.mutate({ id: scope.id, expectedVersion: scope.version });
      }}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          mutation.reset();
          onClose();
        }
      }}
      title="Delete scope?"
    />
  );
}

function sortingToScopeSort(sorting: SortingState) {
  const first = sorting[0] ?? { id: "key", desc: false };
  return `${first.id}.${first.desc ? "desc" : "asc"}` as
    "key.asc" | "key.desc" | "updatedAt.asc" | "updatedAt.desc";
}

function validateScopeKey(value: unknown): string | undefined {
  const key = String(value).trim();
  if (!key) return "Scope key is required.";
  if (!/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/.test(key)) {
    return "Use a lowercase namespace:permission key.";
  }
  return key.length <= 160 ? undefined : "Scope key must be 160 characters or less.";
}

function validateDescription(value: unknown): string | undefined {
  const description = String(value).trim();
  if (!description) return "Description is required.";
  return description.length <= 500 ? undefined : "Description must be 500 characters or less.";
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
