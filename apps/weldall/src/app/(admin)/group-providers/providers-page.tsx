"use client";

import { useId, useMemo, useState } from "react";
import type { AnyFieldApi } from "@tanstack/react-form";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Switch } from "@astryxdesign/core/Switch";
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
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { GroupProviderDto } from "@/server/group-providers/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";
import { sortLabel } from "../table-state";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function GroupProvidersPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const providersQuery = useQuery(trpc.admin.groupProviders.list.queryOptions());
  const [editingProvider, setEditingProvider] = useState<GroupProviderDto | null | undefined>();
  const [deletingProvider, setDeletingProvider] = useState<GroupProviderDto | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const operationToast = useOperationToast();
  const testMutation = useMutation(
    trpc.admin.groupProviders.test.mutationOptions({
      onSuccess: (result) =>
        operationToast.success(
          `Connection succeeded (${result.groupCount} groups, ${result.latencyMs} ms)`,
          "provider-test",
        ),
      onError: (error) => operationToast.error("Connection failed", error, "provider-test"),
    }),
  );
  const deleteMutation = useMutation(
    trpc.admin.groupProviders.delete.mutationOptions({
      onSuccess: async () => {
        setDeletingProvider(null);
        operationToast.success("Group provider deleted", "provider-delete");
        await queryClient.invalidateQueries();
      },
      onError: (error) =>
        operationToast.error("Could not delete provider", error, "provider-delete"),
    }),
  );
  const providers = providersQuery.data ?? [];
  const columns = useMemo<ColumnDef<GroupProviderDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Provider",
        cell: ({ row, getValue }) => (
          <div className="grid gap-1">
            <span className="font-medium">{getValue<string>()}</span>
            <code className="text-xs">{row.original.key}</code>
          </div>
        ),
      },
      {
        accessorKey: "adapterType",
        header: "Adapter",
        cell: () => "Management API v1",
      },
      {
        accessorKey: "baseUrl",
        header: "Base URL",
        cell: ({ getValue }) => <code className="text-sm">{getValue<string>()}</code>,
      },
      {
        accessorKey: "enabled",
        header: "Status",
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Enabled" : "Disabled"}
            variant={getValue<boolean>() ? "success" : "neutral"}
          />
        ),
      },
      {
        accessorKey: "hasToken",
        header: "Credential",
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Configured" : "Missing"}
            variant={getValue<boolean>() ? "neutral" : "warning"}
          />
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
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-2">
            <Button
              isLoading={
                testMutation.isPending &&
                Boolean(
                  testMutation.variables &&
                  "id" in testMutation.variables &&
                  testMutation.variables.id === row.original.id,
                )
              }
              label="Test"
              onClick={() => testMutation.mutate({ id: row.original.id })}
              size="sm"
              variant="secondary"
            />
            <Button
              label="Edit"
              onClick={() => setEditingProvider(row.original)}
              size="sm"
              variant="secondary"
            />
            <Button
              label="Delete"
              onClick={() => setDeletingProvider(row.original)}
              size="sm"
              variant="destructive"
            />
          </div>
        ),
      },
    ],
    [testMutation],
  );
  const table = useReactTable({
    data: providers,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <Button
          label="Add group provider"
          onClick={() => setEditingProvider(null)}
          variant="primary"
        />
      </HerocrumbsActions>
      {providersQuery.error ? (
        <Banner
          container="card"
          description={providersQuery.error.message}
          status="error"
          title="Could not load group providers"
        />
      ) : null}
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
        <div className="w-full overflow-x-auto" role="group" aria-label="Group providers table">
          <table className="w-full min-w-[1000px] border-collapse text-left">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} isHeaderRow>
                  {headerGroup.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const label = String(header.column.columnDef.header ?? "");
                    return (
                      <TableHeaderCell
                        key={header.id}
                        aria-sort={
                          sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined
                        }
                        scope="col"
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
              {!providersQuery.isPending &&
              !providersQuery.error &&
              table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">No group providers have been configured.</Text>
                  </TableCell>
                </TableRow>
              ) : null}
              {providersQuery.isPending ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">Loading group providers…</Text>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </table>
        </div>
      </TableContext.Provider>
      <AlertDialog
        actionLabel="Delete provider"
        description={
          deletingProvider
            ? `Delete ${deletingProvider.name}? Providers with group assignments cannot be deleted.`
            : "Delete this group provider?"
        }
        isActionLoading={deleteMutation.isPending}
        isOpen={Boolean(deletingProvider)}
        onAction={() => {
          if (deletingProvider) {
            deleteMutation.mutate({
              id: deletingProvider.id,
              expectedVersion: deletingProvider.version,
            });
          }
        }}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            deleteMutation.reset();
            setDeletingProvider(null);
          }
        }}
        title="Delete group provider?"
      />
      {editingProvider !== undefined ? (
        <ProviderDialog
          key={editingProvider?.id ?? "new"}
          provider={editingProvider}
          onClose={() => setEditingProvider(undefined)}
          onSaved={async () => {
            setEditingProvider(undefined);
            await queryClient.invalidateQueries();
          }}
        />
      ) : null}
    </>
  );
}

function ProviderDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: GroupProviderDto | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const formId = useId();
  const operationToast = useOperationToast();
  const createMutation = useMutation(
    trpc.admin.groupProviders.create.mutationOptions({
      onSuccess: () => operationToast.success("Group provider created", "provider-save"),
      onError: (error) => operationToast.error("Could not create provider", error, "provider-save"),
    }),
  );
  const updateMutation = useMutation(
    trpc.admin.groupProviders.update.mutationOptions({
      onSuccess: () => operationToast.success("Group provider saved", "provider-save"),
      onError: (error) => operationToast.error("Could not save provider", error, "provider-save"),
    }),
  );
  const testMutation = useMutation(
    trpc.admin.groupProviders.test.mutationOptions({
      onSuccess: (result) =>
        operationToast.success(
          `Connection succeeded (${result.groupCount} groups, ${result.latencyMs} ms)`,
          "provider-dialog-test",
        ),
      onError: (error) => operationToast.error("Connection failed", error, "provider-dialog-test"),
    }),
  );
  const mutation = provider ? updateMutation : createMutation;
  const form = useForm({
    defaultValues: {
      key: provider?.key ?? "",
      name: provider?.name ?? "",
      baseUrl: provider?.baseUrl ?? "",
      token: "",
      enabled: provider?.enabled ?? true,
    },
    onSubmit: async ({ value }) => {
      if (provider) {
        await updateMutation.mutateAsync({
          id: provider.id,
          name: value.name.trim(),
          baseUrl: value.baseUrl.trim(),
          token: value.token.trim() || undefined,
          enabled: value.enabled,
          expectedVersion: provider.version,
        });
      } else {
        await createMutation.mutateAsync({
          key: value.key.trim(),
          name: value.name.trim(),
          baseUrl: value.baseUrl.trim(),
          token: value.token.trim(),
          enabled: value.enabled,
          adapterType: "management-api-v1",
        });
      }
      await onSaved();
    },
  });
  const changeOpen = (open: boolean) => {
    if (!open && !mutation.isPending && !testMutation.isPending) onClose();
  };
  const testConnection = () => {
    const value = form.state.values;
    testMutation.mutate(
      provider
        ? {
            id: provider.id,
            baseUrl: value.baseUrl.trim(),
            token: value.token.trim() || undefined,
          }
        : {
            key: value.key.trim(),
            adapterType: "management-api-v1",
            baseUrl: value.baseUrl.trim(),
            token: value.token.trim(),
          },
    );
  };

  return (
    <Dialog isOpen onOpenChange={changeOpen} purpose="form" width="min(680px, calc(100vw - 32px))">
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={changeOpen}
            subtitle="Credentials are encrypted and write-only. Leave the token empty while editing to preserve it."
            title={provider ? "Edit group provider" : "Add group provider"}
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
                {mutation.error ? (
                  <Banner
                    container="card"
                    description={mutation.error.message}
                    status="error"
                    title="Could not save provider"
                  />
                ) : null}
                <form.Field
                  name="key"
                  validators={{
                    onBlur: ({ value }) => validateProviderKey(value),
                    onChange: ({ value }) => validateProviderKey(value),
                    onSubmit: ({ value }) => validateProviderKey(value),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isDisabled={Boolean(provider)}
                      isRequired
                      label="Key"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="company-directory"
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="name"
                  validators={{
                    onBlur: ({ value }) => validateName(value),
                    onSubmit: ({ value }) => validateName(value),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isRequired
                      label="Name"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="Company directory"
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="baseUrl"
                  validators={{
                    onBlur: ({ value }) => validateBaseUrl(value),
                    onChange: ({ value }) => validateBaseUrl(value),
                    onSubmit: ({ value }) => validateBaseUrl(value),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isRequired
                      label="HTTPS base URL"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="https://directory.example.com"
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="token"
                  validators={{
                    onBlur: ({ value }) => validateToken(value, Boolean(provider)),
                    onSubmit: ({ value }) => validateToken(value, Boolean(provider)),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isOptional={Boolean(provider)}
                      isRequired={!provider}
                      label={provider ? "Replacement token" : "Token"}
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      {...fieldStatusProps(field)}
                      type="password"
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field name="enabled">
                  {(field) => (
                    <Switch
                      description="Disabled providers cannot be used to create new group assignments."
                      label="Enabled"
                      labelPosition="start"
                      labelSpacing="spread"
                      onChange={field.handleChange}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
              </FormLayout>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex w-full items-center justify-end gap-2">
              <form.Subscribe selector={(state) => state.values}>
                {(value) => (
                  <Button
                    className="mr-auto"
                    isDisabled={Boolean(
                      validateProviderKey(value.key) ||
                      validateBaseUrl(value.baseUrl) ||
                      validateToken(value.token, Boolean(provider)),
                    )}
                    isLoading={testMutation.isPending}
                    label="Test connection"
                    onClick={testConnection}
                    type="button"
                    variant="secondary"
                  />
                )}
              </form.Subscribe>
              <Button label="Cancel" onClick={onClose} type="button" variant="secondary" />
              <form.Subscribe selector={(state) => state.canSubmit}>
                {(canSubmit) => (
                  <Button
                    form={formId}
                    isDisabled={!canSubmit}
                    isLoading={mutation.isPending}
                    label={provider ? "Save provider" : "Add provider"}
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

function validateProviderKey(value: unknown): string | undefined {
  const key = String(value).trim();
  if (!key) return "Provider key is required.";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
    return "Use lowercase letters, numbers, dots, dashes, or underscores.";
  }
  return key.length <= 120 ? undefined : "Provider key must be 120 characters or less.";
}

function validateName(value: unknown): string | undefined {
  const name = String(value).trim();
  if (!name) return "Name is required.";
  return name.length <= 200 ? undefined : "Name must be 200 characters or less.";
}

function validateBaseUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? undefined
      : "Base URL must be an HTTPS origin without credentials, path, query, or fragment.";
  } catch {
    return "Base URL must be an absolute HTTPS origin.";
  }
}

function validateToken(value: unknown, isOptional: boolean): string | undefined {
  const token = String(value).trim();
  if (!token) return isOptional ? undefined : "Token is required.";
  if (token.length > 10_000) return "Token must be 10,000 characters or less.";
  return /[\u0000-\u001f\u007f]/.test(token)
    ? "Token must not contain control characters."
    : undefined;
}

function fieldStatusProps(field: AnyFieldApi) {
  const messages = field.state.meta.errors
    .map(errorMessage)
    .filter((message): message is string => Boolean(message));
  return field.state.meta.isValid || messages.length === 0
    ? {}
    : { status: { type: "error" as const, message: messages.join(", ") } };
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return typeof error.message === "string" ? error.message : undefined;
  }
  return undefined;
}
