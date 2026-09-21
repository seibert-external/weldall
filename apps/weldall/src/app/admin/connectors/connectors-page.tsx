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
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
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
import type { ConnectorDto } from "@/server/connectors/admin-service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";

const API_OPTIONS = [
  { value: "gmail", label: "Gmail" },
  { value: "calendar", label: "Google Calendar" },
];
const SCOPE_OPTIONS = [
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar",
].map((value) => ({ value, label: value.replace("https://www.googleapis.com/auth/", "") }));
const emptyConnectors: ConnectorDto[] = [];

export function ConnectorsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery(trpc.admin.connectors.list.queryOptions());
  const [editing, setEditing] = useState<ConnectorDto | null | undefined>();
  const [deleting, setDeleting] = useState<ConnectorDto | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const toast = useOperationToast();
  const deleteMutation = useMutation(
    trpc.admin.connectors.delete.mutationOptions({
      onSuccess: async () => {
        setDeleting(null);
        toast.success("Connector deleted", "connector-delete");
        await queryClient.invalidateQueries();
      },
      onError: (error) => toast.error("Could not delete connector", error, "connector-delete"),
    }),
  );
  const rows = query.data ?? emptyConnectors;
  const columns = useMemo<ColumnDef<ConnectorDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Connector",
        size: 300,
        cell: ({ row, getValue }) => (
          <OverflowFade title={`${getValue<string>()} (${row.original.key})`}>
            <span className="whitespace-nowrap">
              {getValue<string>()} <code className="text-xs">{row.original.key}</code>
            </span>
          </OverflowFade>
        ),
      },
      { accessorKey: "type", header: "Type", size: 140, cell: () => "Google" },
      {
        accessorKey: "enabledApis",
        header: "APIs",
        size: 260,
        cell: ({ getValue }) => getValue<string[]>().map(apiLabel).join(", "),
      },
      {
        accessorKey: "enabled",
        header: "Status",
        size: 130,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Enabled" : "Disabled"}
            variant={getValue<boolean>() ? "success" : "neutral"}
          />
        ),
      },
      { accessorKey: "connectionCount", header: "Connections", size: 150 },
      {
        accessorKey: "hasClientSecret",
        header: "OAuth secret",
        size: 150,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Configured" : "Missing"}
            variant={getValue<boolean>() ? "neutral" : "warning"}
          />
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <div className="admin-table-action-row">
          <Button href="/admin/connections" label="View connections" variant="secondary" />
          <Button label="Add connector" onClick={() => setEditing(null)} variant="primary" />
        </div>
      </HerocrumbsActions>
      {query.error ? (
        <Banner
          container="card"
          description={query.error.message}
          status="error"
          title="Could not load connectors"
        />
      ) : null}
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
        <div className="w-full overflow-x-auto" role="group" aria-label="Connectors table">
          <table
            className="admin-resizable-table table-fixed border-collapse text-left"
            style={{ minWidth: "100%", width: table.getTotalSize() }}
          >
            <ResizableTableHeader table={table} />
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  aria-label={`Edit ${row.original.name}`}
                  data-clickable="true"
                  onClick={(event) => {
                    if (!isInteractiveTableTarget(event.target, event.currentTarget)) {
                      setEditing(row.original);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell, index) => (
                    <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                      {index === 0 ? (
                        <TableRowAction
                          label={`Edit ${row.original.name}`}
                          onActivate={() => setEditing(row.original)}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableRowAction>
                      ) : (
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!query.isPending && rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">No connectors have been configured.</Text>
                  </TableCell>
                </TableRow>
              ) : null}
              {query.isPending ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">Loading connectors…</Text>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </table>
        </div>
      </TableContext.Provider>
      <AlertDialog
        actionLabel="Delete connector"
        description="Connectors with connections cannot be deleted. Disable the connector instead."
        isActionLoading={deleteMutation.isPending}
        isOpen={Boolean(deleting)}
        onAction={() => {
          if (deleting) {
            deleteMutation.mutate({ id: deleting.id, expectedVersion: deleting.version });
          }
        }}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleting(null);
        }}
        title="Delete connector?"
      />
      {editing !== undefined ? (
        <ConnectorDialog
          key={editing?.id ?? "new"}
          connector={editing}
          onClose={() => setEditing(undefined)}
          onDelete={(connector) => {
            setEditing(undefined);
            setDeleting(connector);
          }}
          onSaved={async () => {
            setEditing(undefined);
            await queryClient.invalidateQueries();
          }}
        />
      ) : null}
    </>
  );
}

function ConnectorDialog({
  connector,
  onClose,
  onDelete,
  onSaved,
}: {
  connector: ConnectorDto | null;
  onClose: () => void;
  onDelete: (connector: ConnectorDto) => void;
  onSaved: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const formId = useId();
  const toast = useOperationToast();
  const createMutation = useMutation(
    trpc.admin.connectors.create.mutationOptions({
      onSuccess: () => toast.success("Connector created", "connector-save"),
      onError: (error) => toast.error("Could not create connector", error, "connector-save"),
    }),
  );
  const updateMutation = useMutation(
    trpc.admin.connectors.update.mutationOptions({
      onSuccess: () => toast.success("Connector saved", "connector-save"),
      onError: (error) => toast.error("Could not save connector", error, "connector-save"),
    }),
  );
  const testMutation = useMutation(
    trpc.admin.connectors.test.mutationOptions({
      onSuccess: (result) =>
        toast.success(
          `Google OAuth endpoints are available (${result.latencyMs} ms)`,
          "connector-test",
        ),
      onError: (error) => toast.error("Connector test failed", error, "connector-test"),
    }),
  );
  const mutation = connector ? updateMutation : createMutation;
  const form = useForm({
    defaultValues: {
      key: connector?.key ?? "",
      name: connector?.name ?? "",
      enabledApis: connector?.enabledApis ?? (["calendar"] as Array<"gmail" | "calendar">),
      oauthScopes: connector?.oauthScopes ?? ["https://www.googleapis.com/auth/calendar.readonly"],
      oauthClientId: connector?.oauthClientId ?? "",
      oauthClientSecret: "",
      enabled: connector?.enabled ?? true,
    },
    onSubmit: async ({ value }) => {
      if (connector) {
        await updateMutation.mutateAsync({
          id: connector.id,
          name: value.name.trim(),
          enabledApis: value.enabledApis,
          oauthScopes: value.oauthScopes,
          oauthClientId: value.oauthClientId.trim(),
          oauthClientSecret: value.oauthClientSecret.trim() || undefined,
          enabled: value.enabled,
          expectedVersion: connector.version,
        });
      } else {
        await createMutation.mutateAsync({
          key: value.key.trim(),
          name: value.name.trim(),
          type: "google",
          enabledApis: value.enabledApis,
          oauthScopes: value.oauthScopes,
          oauthClientId: value.oauthClientId.trim(),
          oauthClientSecret: value.oauthClientSecret.trim(),
          enabled: value.enabled,
        });
      }
      await onSaved();
    },
  });

  const testConfiguration = () => {
    const value = form.state.values;
    testMutation.mutate({
      ...(connector ? { id: connector.id } : {}),
      enabledApis: value.enabledApis,
      oauthScopes: value.oauthScopes,
      oauthClientId: value.oauthClientId.trim(),
      oauthClientSecret: value.oauthClientSecret.trim() || undefined,
    } as Parameters<typeof testMutation.mutate>[0]);
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && !mutation.isPending && !testMutation.isPending && onClose()}
      purpose="form"
      width="min(720px, calc(100vw - 32px))"
    >
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={(open) =>
              !open && !mutation.isPending && !testMutation.isPending && onClose()
            }
            subtitle="The OAuth client secret is encrypted and write-only. Google credentials stay on user devices."
            title={connector ? "Edit Google connector" : "Add Google connector"}
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
                    title="Could not save connector"
                  />
                ) : null}
                <form.Field name="key" validators={{ onSubmit: ({ value }) => requiredKey(value) }}>
                  {(field) => (
                    <TextInput
                      isDisabled={Boolean(connector)}
                      isRequired
                      label="Key"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="google-workspace"
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="name"
                  validators={{ onSubmit: ({ value }) => required(value, "Name", 200) }}
                >
                  {(field) => (
                    <TextInput
                      isRequired
                      label="Name"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="enabledApis"
                  validators={{
                    onSubmit: ({ value }) =>
                      value.length ? undefined : "Choose at least one API.",
                  }}
                >
                  {(field) => (
                    <MultiSelector
                      label="Enabled APIs"
                      options={API_OPTIONS}
                      onChange={(value) => field.handleChange(value as Array<"gmail" | "calendar">)}
                      value={field.state.value}
                      triggerDisplay="badges"
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="oauthScopes"
                  validators={{
                    onSubmit: ({ value }) =>
                      value.length ? undefined : "Choose at least one scope.",
                  }}
                >
                  {(field) => (
                    <MultiSelector
                      hasSearch
                      label="Google OAuth scopes"
                      options={SCOPE_OPTIONS}
                      onChange={field.handleChange}
                      value={field.state.value}
                      triggerDisplay="badges"
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="oauthClientId"
                  validators={{ onSubmit: ({ value }) => required(value, "OAuth client ID", 500) }}
                >
                  {(field) => (
                    <TextInput
                      isRequired
                      label="OAuth client ID"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="oauthClientSecret"
                  validators={{
                    onSubmit: ({ value }) =>
                      connector && !String(value).trim()
                        ? undefined
                        : required(value, "OAuth client secret", 10_000),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isOptional={Boolean(connector)}
                      isRequired={!connector}
                      label={connector ? "Replacement OAuth client secret" : "OAuth client secret"}
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      type="password"
                      {...fieldStatusProps(field)}
                      value={String(field.state.value)}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field name="enabled">
                  {(field) => (
                    <Switch
                      description="Disabled connectors reject new authorizations and connection leases."
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
              <Button
                className={connector ? undefined : "mr-auto"}
                isDisabled={mutation.isPending}
                isLoading={testMutation.isPending}
                label="Test configuration"
                onClick={testConfiguration}
                type="button"
                variant="secondary"
              />
              {connector ? (
                <Button
                  className="mr-auto"
                  label="Delete connector"
                  onClick={() => onDelete(connector)}
                  type="button"
                  variant="destructive"
                />
              ) : null}
              <Button label="Cancel" onClick={onClose} type="button" variant="secondary" />
              <form.Subscribe selector={(state) => state.canSubmit}>
                {(canSubmit) => (
                  <Button
                    form={formId}
                    isDisabled={!canSubmit || testMutation.isPending}
                    isLoading={mutation.isPending}
                    label={connector ? "Save connector" : "Add connector"}
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

function apiLabel(value: string) {
  return value === "gmail" ? "Gmail" : value === "calendar" ? "Google Calendar" : value;
}

function required(value: unknown, label: string, maximum: number) {
  const text = String(value).trim();
  if (!text) return `${label} is required.`;
  return text.length <= maximum ? undefined : `${label} must be ${maximum} characters or less.`;
}

function requiredKey(value: unknown) {
  const key = String(value).trim();
  if (!key) return "Key is required.";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key))
    return "Use lowercase letters, numbers, dots, dashes, or underscores.";
  return key.length <= 120 ? undefined : "Key must be 120 characters or less.";
}

function fieldStatusProps(field: AnyFieldApi) {
  const messages = field.state.meta.errors
    .map((error) =>
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String(error.message)
          : undefined,
    )
    .filter((message): message is string => Boolean(message));
  return field.state.meta.isValid || messages.length === 0
    ? {}
    : { status: { type: "error" as const, message: messages.join(", ") } };
}
