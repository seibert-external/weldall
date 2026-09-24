"use client";

import { useId, useMemo, useState } from "react";
import type { AnyFieldApi } from "@tanstack/react-form";
import type { ColumnDef, SortingState, Table as TanStackTable } from "@tanstack/react-table";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
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
import type { KeyConfig } from "@/server/connectors/contracts";
import type { listManagedConnectorConfiguration } from "@/server/connectors/configuration";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";

type Configuration = Awaited<ReturnType<typeof listManagedConnectorConfiguration>>;
type KeyRow = Configuration["keys"][number];
const emptyKeys: KeyRow[] = [];

/** Renders the logical encryption-key admin workspace and provider availability state. */
/** Coordinates encryption-key administration, filtering, editing, and safe deletion. */
export function KeysPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const operationToast = useOperationToast();
  const configurationQuery = useQuery(trpc.admin.managed.configuration.queryOptions());
  const [editingKey, setEditingKey] = useState<KeyRow | null | undefined>();
  const [deletingKey, setDeletingKey] = useState<KeyRow | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const keys = configurationQuery.data?.keys ?? emptyKeys;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.admin.managed.configuration.queryKey() });
  };
  const deleteMutation = useMutation(
    trpc.admin.managed.deleteKey.mutationOptions({
      onSuccess: async () => {
        setDeletingKey(null);
        operationToast.success("Encryption key deleted", "encryption-key-delete");
        await refresh();
      },
      onError: (error) =>
        operationToast.error("Could not delete encryption key", error, "encryption-key-delete"),
    }),
  );
  const columns = useMemo<ColumnDef<KeyRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.config.name,
        header: "Encryption key",
        size: 320,
        minSize: 180,
        maxSize: 460,
        cell: ({ row, getValue }) => (
          <OverflowFade title={`${getValue<string>()} (${row.original.config.key})`}>
            <div className="flex w-max items-center gap-2 whitespace-nowrap">
              <span>{getValue<string>()}</span>
              <code className="text-xs">{row.original.config.key}</code>
            </div>
          </OverflowFade>
        ),
      },
      {
        id: "activeVersion",
        accessorFn: (row) => row.config.activeVersion,
        header: "Active version",
        size: 170,
        minSize: 130,
        maxSize: 220,
        cell: ({ getValue }) => <code className="text-sm">{getValue<string>()}</code>,
      },
      {
        id: "versions",
        accessorFn: (row) => Object.keys(row.config.versions).length,
        header: "Registered versions",
        size: 190,
        minSize: 150,
        maxSize: 240,
        cell: ({ row, getValue }) => (
          <span title={Object.keys(row.original.config.versions).join(", ")}>
            {getValue<number>().toLocaleString()} version{getValue<number>() === 1 ? "" : "s"}
          </span>
        ),
      },
      {
        id: "availability",
        accessorFn: (row) => row.available,
        header: "Material",
        size: 150,
        minSize: 120,
        maxSize: 200,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Available" : "Unavailable"}
            variant={getValue<boolean>() ? "success" : "error"}
          />
        ),
      },
      {
        id: "management",
        accessorFn: (row) => row.managed,
        header: "Management",
        size: 140,
        minSize: 120,
        maxSize: 180,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "IaC" : "Manual"}
            variant={getValue<boolean>() ? "purple" : "neutral"}
          />
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: keys,
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
          <Button href="/admin/connectors" label="Connectors" variant="secondary" />
          <Button
            label="Add encryption key"
            onClick={() => setEditingKey(null)}
            variant="primary"
          />
        </div>
      </HerocrumbsActions>
      <Text color="secondary">
        Map logical keys to deployment-approved environment variables. Key material never enters the
        database or this UI.
      </Text>
      {configurationQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load encryption keys"
          description={configurationQuery.error.message}
        />
      ) : null}
      <KeysTable
        table={table}
        columns={columns}
        isPending={configurationQuery.isPending}
        onEdit={setEditingKey}
      />
      {editingKey !== undefined ? (
        <KeyDialog
          key={editingKey?.id ?? "new"}
          row={editingKey}
          onClose={() => setEditingKey(undefined)}
          onDelete={(row) => {
            setEditingKey(undefined);
            setDeletingKey(row);
          }}
          onSaved={async () => {
            setEditingKey(undefined);
            await refresh();
          }}
        />
      ) : null}
      <AlertDialog
        actionLabel="Delete encryption key"
        description={
          deletingKey
            ? `Delete ${deletingKey.config.name}? Keys referenced by connectors or encrypted values cannot be deleted.`
            : "Delete this encryption key?"
        }
        isActionLoading={deleteMutation.isPending}
        isOpen={Boolean(deletingKey)}
        onAction={() => {
          if (deletingKey)
            deleteMutation.mutate({ id: deletingKey.id, version: deletingKey.version });
        }}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeletingKey(null);
        }}
        title="Delete encryption key?"
      />
    </>
  );
}

/** Renders the sortable encryption-key table and forwards row activation into editing. */
/** Renders encryption keys and versions in the shared sortable admin-table layout. */
function KeysTable({
  table,
  columns,
  isPending,
  onEdit,
}: {
  table: TanStackTable<KeyRow>;
  columns: ColumnDef<KeyRow>[];
  isPending: boolean;
  onEdit: (row: KeyRow) => void;
}) {
  return (
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
      <div className="w-full overflow-x-auto" role="group" aria-label="Encryption keys table">
        <table
          className="admin-resizable-table table-fixed border-collapse text-left"
          style={{ minWidth: "100%", width: table.getTotalSize() }}
        >
          <ResizableTableHeader table={table} />
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                aria-label={`Edit ${row.original.config.name}`}
                data-clickable="true"
                onClick={(event) => {
                  if (!isInteractiveTableTarget(event.target, event.currentTarget))
                    onEdit(row.original);
                }}
              >
                {row.getVisibleCells().map((cell, index) => (
                  <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                    {index === 0 ? (
                      <TableRowAction
                        label={`Edit ${row.original.config.name}`}
                        onActivate={() => onEdit(row.original)}
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
            {!isPending && table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <Text color="secondary">No encryption keys have been configured.</Text>
                </TableCell>
              </TableRow>
            ) : null}
            {isPending ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <Text color="secondary">Loading encryption keys…</Text>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </table>
      </div>
    </TableContext.Provider>
  );
}

/** Owns logical key creation, version registration, and active-version selection. */
/** Collects provider bindings and versions before submitting an encryption-key mutation. */
function KeyDialog({
  row,
  onClose,
  onDelete,
  onSaved,
}: {
  row: KeyRow | null;
  onClose: () => void;
  onDelete: (row: KeyRow) => void;
  onSaved: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const formId = useId();
  const operationToast = useOperationToast();
  const existingVersions = row?.config.versions ?? {};
  const saveMutation = useMutation(
    trpc.admin.managed.saveKey.mutationOptions({
      onSuccess: () =>
        operationToast.success(
          row ? "Encryption key saved" : "Encryption key created",
          "encryption-key-save",
        ),
      onError: (error) =>
        operationToast.error("Could not save encryption key", error, "encryption-key-save"),
    }),
  );
  const form = useForm({
    defaultValues: {
      key: row?.config.key ?? "",
      name: row?.config.name ?? "",
      activeVersion: row?.config.activeVersion ?? "1",
      initialSource: row ? "" : "DEV_MANAGED_CONNECTOR_KEY_PRIMARY",
      newVersion: "",
      newSource: "",
    },
    onSubmit: async ({ value }) => {
      const versions: KeyConfig["versions"] = row
        ? { ...existingVersions }
        : {
            "1": {
              source: { type: "local-env", variable: value.initialSource.trim() },
            },
          };
      if (row && value.newVersion.trim() && value.newSource.trim()) {
        versions[value.newVersion.trim()] = {
          source: { type: "local-env", variable: value.newSource.trim() },
        };
      }
      await saveMutation.mutateAsync({
        ...(row ? { id: row.id } : {}),
        version: row?.version ?? null,
        config: {
          key: value.key.trim(),
          name: value.name.trim(),
          activeVersion: value.activeVersion,
          versions,
        },
      });
      await onSaved();
    },
  });
  const changeOpen = (open: boolean) => {
    if (!open && !saveMutation.isPending) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={changeOpen} purpose="form" width="min(700px, calc(100vw - 32px))">
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={changeOpen}
            subtitle="Bindings are immutable after registration so backups remain decryptable."
            title={row ? "Edit encryption key" : "Add encryption key"}
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
                    onBlur: ({ value }) => validateIdentity({ value, label: "Key" }),
                    onChange: ({ value }) => validateIdentity({ value, label: "Key" }),
                    onSubmit: ({ value }) => validateIdentity({ value, label: "Key" }),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isDisabled={Boolean(row)}
                      isRequired
                      label="Key"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="managed-primary"
                      {...getFieldStatusProps(field)}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="name"
                  validators={{
                    onBlur: ({ value }) => validateRequired({ value, label: "Name", max: 200 }),
                    onSubmit: ({ value }) => validateRequired({ value, label: "Name", max: 200 }),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isRequired
                      label="Name"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="Managed connector primary key"
                      {...getFieldStatusProps(field)}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
                {!row ? (
                  <form.Field
                    name="initialSource"
                    validators={{
                      onBlur: ({ value }) => validateEnvironmentName(value),
                      onChange: ({ value }) => validateEnvironmentName(value),
                      onSubmit: ({ value }) => validateEnvironmentName(value),
                    }}
                  >
                    {(field) => (
                      <TextInput
                        isRequired
                        label="Version 1 environment variable"
                        onBlur={field.handleBlur}
                        onChange={field.handleChange}
                        {...getFieldStatusProps(field)}
                        value={field.state.value}
                        width="100%"
                      />
                    )}
                  </form.Field>
                ) : null}
                {row ? (
                  <div className="grid gap-2">
                    <Text weight="semibold">Registered versions</Text>
                    {Object.entries(existingVersions).map(([version, entry]) => (
                      <div
                        key={version}
                        className="border-border bg-surface flex items-center justify-between gap-4 border p-3"
                      >
                        <code>{version}</code>
                        <code className="text-sm">{entry.source.variable}</code>
                      </div>
                    ))}
                  </div>
                ) : null}
                {row ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <form.Field
                      name="newVersion"
                      validators={{
                        onChange: ({ value }) =>
                          value
                            ? (validateIdentity({ value, label: "Version" }) ??
                              (value in existingVersions
                                ? "This version is already registered."
                                : undefined))
                            : undefined,
                        onSubmit: ({ value }) =>
                          value || !form.state.values.newSource
                            ? undefined
                            : "Version is required when a source is entered.",
                      }}
                    >
                      {(field) => (
                        <TextInput
                          isOptional
                          label="New version"
                          onChange={(value) => {
                            field.handleChange(value);
                            if (
                              form.state.values.activeVersion &&
                              !existingVersions[form.state.values.activeVersion]
                            )
                              form.setFieldValue("activeVersion", value);
                          }}
                          placeholder="2"
                          {...getFieldStatusProps(field)}
                          value={field.state.value}
                          width="100%"
                        />
                      )}
                    </form.Field>
                    <form.Field
                      name="newSource"
                      validators={{
                        onChange: ({ value }) =>
                          value ? validateEnvironmentName(value) : undefined,
                        onSubmit: ({ value }) =>
                          value || !form.state.values.newVersion
                            ? undefined
                            : "Environment variable is required for the new version.",
                      }}
                    >
                      {(field) => (
                        <TextInput
                          isOptional
                          label="New environment variable"
                          onChange={field.handleChange}
                          placeholder="CONNECTOR_KEY_V2"
                          {...getFieldStatusProps(field)}
                          value={field.state.value}
                          width="100%"
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                <form.Subscribe selector={(state) => state.values.newVersion}>
                  {(newVersion) => {
                    const versionOptions = [
                      ...Object.keys(existingVersions).map((version) => ({
                        value: version,
                        label: version,
                      })),
                      ...(!row ? [{ value: "1", label: "1" }] : []),
                      ...(row && newVersion ? [{ value: newVersion, label: newVersion }] : []),
                    ];
                    return (
                      <form.Field
                        name="activeVersion"
                        validators={{
                          onSubmit: ({ value }) =>
                            value ? undefined : "Choose an active version.",
                        }}
                      >
                        {(field) => (
                          <Selector
                            isRequired
                            label="Active version"
                            onChange={(value) => field.handleChange(value ?? "")}
                            options={versionOptions}
                            value={field.state.value}
                            width="100%"
                          />
                        )}
                      </form.Field>
                    );
                  }}
                </form.Subscribe>
                <Banner
                  container="card"
                  status="info"
                  title="Rotation is explicit"
                  description="Provision the new random key on every instance before registering it. Activating a version does not re-encrypt existing values; retain historical material for recovery."
                />
              </FormLayout>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex w-full items-center justify-end gap-2">
              {row ? (
                <Button
                  className="mr-auto"
                  label="Delete key"
                  onClick={() => onDelete(row)}
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
                    isLoading={saveMutation.isPending}
                    label={row ? "Save key" : "Add key"}
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

/** Validates stable logical-key and version identifiers used by UI and IaC. */
/** Validates stable key and version identifiers used by IaC and ciphertext references. */
function validateIdentity({ value, label }: { value: unknown; label: string }) {
  const key = String(value).trim();
  if (!key) return `${label} is required.`;
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(key))
    return "Use lowercase letters, numbers, dots, dashes, or underscores (120 characters maximum).";
}
/** Validates the local-env provider variable reference without resolving secret material. */
/** Validates the approved environment-variable name for a local key provider. */
function validateEnvironmentName(value: unknown) {
  const name = String(value).trim();
  if (!name) return "Environment variable is required.";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(name))
    return "Use a valid environment variable name (200 characters maximum).";
}
/** Validates bounded required text before the shared key configuration mutation. */
/** Validates required trimmed encryption-key form fields with a size limit. */
function validateRequired({ value, label, max }: { value: unknown; label: string; max: number }) {
  const text = String(value).trim();
  if (!text) return `${label} is required.`;
  if (text.length > max) return `${label} must be ${max.toLocaleString()} characters or less.`;
}
/** Adapts TanStack Form validation state to Astryx input status props. */
/** Adapts TanStack field state to Astryx input status properties. */
function getFieldStatusProps(field: AnyFieldApi) {
  const messages = field.state.meta.errors
    .map(getErrorMessage)
    .filter((message): message is string => Boolean(message));
  return field.state.meta.isValid || messages.length === 0
    ? {}
    : { status: { type: "error" as const, message: messages.join(", ") } };
}
/** Normalizes unknown validation errors for administrator-facing feedback. */
/** Normalizes unknown mutation failures for the encryption-key admin dialog. */
function getErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message;
}
