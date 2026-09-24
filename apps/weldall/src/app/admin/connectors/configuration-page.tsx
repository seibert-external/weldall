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
import { Selector } from "@astryxdesign/core/Selector";
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
import type { ConnectorConfig } from "@/server/connectors/contracts";
import type { listManagedConnectorConfiguration } from "@/server/connectors/configuration";
import { scopeCatalog } from "@/server/connectors/scopes";
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
type ConnectorRow = Configuration["connectors"][number];
type ConnectorAction = { type: "delete" | "reencrypt"; connector: ConnectorRow };
const emptyConnectors: ConnectorRow[] = [];
const emptyKeys: Configuration["keys"] = [];
const apiOptions = [
  { value: "gmail", label: "Gmail" },
  { value: "calendar", label: "Google Calendar" },
];

/** Renders the connector-definition admin workspace backed by shared tRPC configuration data. */
/** Coordinates connector administration, filtering, editing, and lifecycle mutations. */
export function ManagedConfiguration() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const operationToast = useOperationToast();
  const configurationQuery = useQuery(trpc.admin.managed.configuration.queryOptions());
  const [editingConnector, setEditingConnector] = useState<ConnectorRow | null | undefined>();
  const [action, setAction] = useState<ConnectorAction | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const connectors = configurationQuery.data?.connectors ?? emptyConnectors;
  const keys = configurationQuery.data?.keys ?? emptyKeys;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.admin.managed.configuration.queryKey() });
  };
  const deleteMutation = useMutation(
    trpc.admin.managed.deleteConnector.mutationOptions({
      onSuccess: async () => {
        setAction(null);
        operationToast.success("Connector deleted", "connector-delete");
        await refresh();
      },
      onError: (error) =>
        operationToast.error("Could not delete connector", error, "connector-delete"),
    }),
  );
  const reencryptMutation = useMutation(
    trpc.admin.managed.reencrypt.mutationOptions({
      onSuccess: async (result) => {
        setAction(null);
        operationToast.success(
          `Re-encrypted ${result.count.toLocaleString()} stored value${result.count === 1 ? "" : "s"}`,
          "connector-reencrypt",
        );
        await refresh();
      },
      onError: (error) =>
        operationToast.error("Could not re-encrypt connector values", error, "connector-reencrypt"),
    }),
  );
  const columns = useMemo<ColumnDef<ConnectorRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.config.name,
        header: "Connector",
        size: 300,
        minSize: 180,
        maxSize: 440,
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
        id: "apis",
        accessorFn: (row) => row.config.enabledApis.join(", "),
        header: "APIs",
        size: 210,
        minSize: 150,
        maxSize: 300,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.config.enabledApis.map((api) => (
              <Badge key={api} label={api === "gmail" ? "Gmail" : "Calendar"} variant="info" />
            ))}
          </div>
        ),
      },
      {
        id: "permissions",
        accessorFn: (row) => row.config.allowedScopes.length,
        header: "Permissions",
        size: 150,
        minSize: 120,
        maxSize: 190,
        cell: ({ getValue }) => `${getValue<number>().toLocaleString()} allowed`,
      },
      {
        id: "encryptionKey",
        accessorFn: (row) => row.config.encryptionKey,
        header: "Encryption key",
        size: 220,
        minSize: 150,
        maxSize: 320,
        cell: ({ getValue }) => (
          <code className="whitespace-nowrap text-sm">{getValue<string>()}</code>
        ),
      },
      {
        id: "secret",
        accessorFn: (row) => row.secretConfigured,
        header: "Client secret",
        size: 150,
        minSize: 120,
        maxSize: 200,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Configured" : "Missing"}
            variant={getValue<boolean>() ? "neutral" : "warning"}
          />
        ),
      },
      {
        id: "enabled",
        accessorFn: (row) => row.config.enabled,
        header: "Status",
        size: 130,
        minSize: 110,
        maxSize: 180,
        cell: ({ row, getValue }) => (
          <div className="flex flex-wrap gap-1">
            <Badge
              label={getValue<boolean>() ? "Enabled" : "Disabled"}
              variant={getValue<boolean>() ? "success" : "neutral"}
            />
            {row.original.managed ? <Badge label="IaC" variant="purple" /> : null}
          </div>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: connectors,
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
          <Button href="/admin/keys" label="Encryption keys" variant="secondary" />
          <Button
            label="Add connector"
            onClick={() => setEditingConnector(null)}
            variant="primary"
          />
        </div>
      </HerocrumbsActions>
      <Text color="secondary">
        Configure provider clients and the permissions users may grant. Client secrets are
        write-only.
      </Text>
      {configurationQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load connectors"
          description={configurationQuery.error.message}
        />
      ) : null}
      <ManagedTable
        label="Connectors table"
        table={table}
        columns={columns}
        isPending={configurationQuery.isPending}
        empty="No connectors have been configured."
        onEdit={setEditingConnector}
      />
      {editingConnector !== undefined ? (
        <ConnectorDialog
          key={editingConnector?.id ?? "new"}
          connector={editingConnector}
          keys={keys}
          onClose={() => setEditingConnector(undefined)}
          onDelete={(connector) => {
            setEditingConnector(undefined);
            setAction({ type: "delete", connector });
          }}
          onReencrypt={(connector) => {
            setEditingConnector(undefined);
            setAction({ type: "reencrypt", connector });
          }}
          onSaved={async () => {
            setEditingConnector(undefined);
            await refresh();
          }}
        />
      ) : null}
      <AlertDialog
        actionLabel={action?.type === "delete" ? "Delete connector" : "Re-encrypt values"}
        description={
          action?.type === "delete"
            ? `Delete ${action.connector.config.name}? Connections and authorization attempts must be removed first.`
            : action
              ? `Synchronously re-encrypt every stored value for ${action.connector.config.name} with its selected active key version? The operation rolls back on failure.`
              : "Confirm this connector operation."
        }
        isActionLoading={deleteMutation.isPending || reencryptMutation.isPending}
        isOpen={Boolean(action)}
        onAction={() => {
          if (!action) return;
          if (action.type === "delete")
            deleteMutation.mutate({ id: action.connector.id, version: action.connector.version });
          else
            reencryptMutation.mutate({
              id: action.connector.id,
              version: action.connector.version,
            });
        }}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending && !reencryptMutation.isPending) setAction(null);
        }}
        title={action?.type === "delete" ? "Delete connector?" : "Re-encrypt stored values?"}
      />
    </>
  );
}

/** Renders the sortable connector table and forwards row activation into the edit workflow. */
/** Renders managed connectors in the shared sortable admin-table layout. */
function ManagedTable({
  label,
  table,
  columns,
  isPending,
  empty,
  onEdit,
}: {
  label: string;
  table: ReturnType<typeof useReactTable<ConnectorRow>>;
  columns: ColumnDef<ConnectorRow>[];
  isPending: boolean;
  empty: string;
  onEdit: (row: ConnectorRow) => void;
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
      <div className="w-full overflow-x-auto" role="group" aria-label={label}>
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
                  <Text color="secondary">{empty}</Text>
                </TableCell>
              </TableRow>
            ) : null}
            {isPending ? (
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
  );
}

/** Owns connector configuration and write-only client-secret forms for one admin dialog. */
/** Collects and validates connector configuration before the admin mutation is submitted. */
function ConnectorDialog({
  connector,
  keys,
  onClose,
  onDelete,
  onReencrypt,
  onSaved,
}: {
  connector: ConnectorRow | null;
  keys: Configuration["keys"];
  onClose: () => void;
  onDelete: (connector: ConnectorRow) => void;
  onReencrypt: (connector: ConnectorRow) => void;
  onSaved: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const formId = useId();
  const secretFormId = useId();
  const operationToast = useOperationToast();
  const saveMutation = useMutation(
    trpc.admin.managed.saveConnector.mutationOptions({
      onSuccess: () =>
        operationToast.success(
          connector ? "Connector saved" : "Connector created",
          "connector-save",
        ),
      onError: (error) => operationToast.error("Could not save connector", error, "connector-save"),
    }),
  );
  const secretMutation = useMutation(
    trpc.admin.managed.secret.mutationOptions({
      onSuccess: () => operationToast.success("Client secret provisioned", "connector-secret"),
      onError: (error) =>
        operationToast.error("Could not provision client secret", error, "connector-secret"),
    }),
  );
  const config = connector?.config;
  const form = useForm({
    defaultValues: {
      key: config?.key ?? "",
      name: config?.name ?? "",
      clientId: config?.clientId ?? "",
      encryptionKey: config?.encryptionKey ?? "",
      enabledApis: config?.enabledApis ?? (["gmail", "calendar"] as ("gmail" | "calendar")[]),
      allowedScopes: config?.allowedScopes ?? [],
      defaultScopes: config?.defaultScopes ?? [],
      enabled: config?.enabled ?? false,
    },
    onSubmit: async ({ value }) => {
      await saveMutation.mutateAsync({
        ...(connector ? { id: connector.id } : {}),
        version: connector?.version ?? null,
        config: { ...value, type: "google" } satisfies ConnectorConfig,
      });
      await onSaved();
    },
  });
  const secretForm = useForm({
    defaultValues: { secret: "" },
    onSubmit: async ({ value }) => {
      if (!connector) return;
      await secretMutation.mutateAsync({
        id: connector.id,
        version: connector.version,
        secret: value.secret,
      });
      await onSaved();
    },
  });
  const busy = saveMutation.isPending || secretMutation.isPending;
  const changeOpen = (open: boolean) => {
    if (!open && !busy) onClose();
  };

  return (
    <Dialog isOpen onOpenChange={changeOpen} purpose="form" width="min(760px, calc(100vw - 32px))">
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={changeOpen}
            subtitle="Google OAuth configuration, permission policy, and encryption binding."
            title={connector ? "Edit connector" : "Add connector"}
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
                    onBlur: ({ value }) => validateIdentity({ value, label: "Connector key" }),
                    onChange: ({ value }) => validateIdentity({ value, label: "Connector key" }),
                    onSubmit: ({ value }) => validateIdentity({ value, label: "Connector key" }),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isDisabled={Boolean(connector)}
                      isRequired
                      label="Connector key"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="google-workspace"
                      {...getFieldStatusProps(field)}
                      value={field.state.value}
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
                      placeholder="Company Google Workspace"
                      {...getFieldStatusProps(field)}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="clientId"
                  validators={{
                    onBlur: ({ value }) =>
                      validateRequired({ value, label: "OAuth client ID", max: 500 }),
                    onSubmit: ({ value }) =>
                      validateRequired({ value, label: "OAuth client ID", max: 500 }),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isRequired
                      label="OAuth client ID"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="123456.apps.googleusercontent.com"
                      {...getFieldStatusProps(field)}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="encryptionKey"
                  validators={{
                    onChange: ({ value }) => (value ? undefined : "Choose an encryption key."),
                    onSubmit: ({ value }) => (value ? undefined : "Choose an encryption key."),
                  }}
                >
                  {(field) => (
                    <Selector
                      hasClear
                      isRequired
                      label="Encryption key"
                      onChange={(value) => field.handleChange(value ?? "")}
                      options={keys.map((key) => ({
                        value: key.config.key,
                        label: `${key.config.name}${key.available ? "" : " (unavailable)"}`,
                      }))}
                      placeholder="Choose a key…"
                      {...getFieldStatusProps(field)}
                      value={field.state.value || null}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="enabledApis"
                  validators={{
                    onChange: ({ value }) =>
                      value.length ? undefined : "Enable at least one API.",
                    onSubmit: ({ value }) =>
                      value.length ? undefined : "Enable at least one API.",
                  }}
                >
                  {(field) => (
                    <MultiSelector
                      label="Enabled APIs"
                      onChange={(values) => {
                        const enabledApis = values as ("gmail" | "calendar")[];
                        field.handleChange(enabledApis);
                        const allowed = form.state.values.allowedScopes.filter((id) =>
                          isScopeForEnabledApi({ id, enabledApis }),
                        );
                        form.setFieldValue("allowedScopes", allowed);
                        form.setFieldValue(
                          "defaultScopes",
                          form.state.values.defaultScopes.filter((id) => allowed.includes(id)),
                        );
                      }}
                      options={apiOptions}
                      {...getFieldStatusProps(field)}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Subscribe
                  selector={(state) =>
                    [state.values.enabledApis, state.values.allowedScopes] as const
                  }
                >
                  {([enabledApis, allowedScopes]) => {
                    const allowedScopeOptions = scopeCatalog
                      .filter(
                        (scope) =>
                          !scope.required &&
                          enabledApis.includes(scope.group.toLowerCase() as "gmail" | "calendar"),
                      )
                      .map((scope) => ({
                        value: scope.id,
                        label: `${scope.group}: ${scope.label}`,
                      }));
                    const defaultScopeOptions = allowedScopeOptions.filter((option) =>
                      allowedScopes.includes(option.value),
                    );
                    return (
                      <>
                        <form.Field
                          name="allowedScopes"
                          validators={{
                            onChange: ({ value }) =>
                              value.length ? undefined : "Allow at least one permission.",
                            onSubmit: ({ value }) =>
                              value.length ? undefined : "Allow at least one permission.",
                          }}
                        >
                          {(field) => (
                            <MultiSelector
                              hasSearch
                              label="Allowed permissions"
                              onChange={(values) => {
                                field.handleChange(values);
                                form.setFieldValue(
                                  "defaultScopes",
                                  form.state.values.defaultScopes.filter((id) =>
                                    values.includes(id),
                                  ),
                                );
                              }}
                              options={allowedScopeOptions}
                              placeholder="Choose permissions…"
                              {...getFieldStatusProps(field)}
                              triggerDisplay="badges"
                              value={field.state.value}
                              width="100%"
                            />
                          )}
                        </form.Field>
                        <form.Field name="defaultScopes">
                          {(field) => (
                            <MultiSelector
                              hasClear
                              hasSearch
                              label="Selected by default"
                              onChange={field.handleChange}
                              options={defaultScopeOptions}
                              placeholder="No optional defaults"
                              triggerDisplay="badges"
                              value={field.state.value}
                              width="100%"
                            />
                          )}
                        </form.Field>
                      </>
                    );
                  }}
                </form.Subscribe>
                <form.Field name="enabled">
                  {(field) => (
                    <Switch
                      description={
                        connector?.secretConfigured
                          ? "Users may create and use connections through this connector."
                          : "Provision a client secret before enabling this connector."
                      }
                      isDisabled={!connector?.secretConfigured}
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
            {connector ? (
              <>
                <hr className="border-border my-5 border-0 border-t" />
                <form
                  className="admin-dialog-form"
                  id={secretFormId}
                  onSubmit={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void secretForm.handleSubmit();
                  }}
                >
                  <FormLayout>
                    <secretForm.Field
                      name="secret"
                      validators={{
                        onSubmit: ({ value }) =>
                          validateRequired({ value, label: "Client secret", max: 10_000 }),
                      }}
                    >
                      {(field) => (
                        <TextInput
                          isRequired
                          label={
                            connector.secretConfigured
                              ? "Replacement client secret"
                              : "Client secret"
                          }
                          onChange={field.handleChange}
                          type="password"
                          {...getFieldStatusProps(field)}
                          value={field.state.value}
                          width="100%"
                        />
                      )}
                    </secretForm.Field>
                    <div className="flex justify-end">
                      <secretForm.Subscribe selector={(state) => state.canSubmit}>
                        <Button
                          form={secretFormId}
                          isDisabled={!secretForm.state.values.secret}
                          isLoading={secretMutation.isPending}
                          label={connector.secretConfigured ? "Replace secret" : "Provision secret"}
                          type="submit"
                          variant="secondary"
                        />
                      </secretForm.Subscribe>
                    </div>
                  </FormLayout>
                </form>
              </>
            ) : null}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              {connector ? (
                <>
                  <Button
                    className="mr-auto"
                    isDisabled={busy}
                    label="Delete connector"
                    onClick={() => onDelete(connector)}
                    type="button"
                    variant="destructive"
                  />
                  <Button
                    isDisabled={busy}
                    label="Re-encrypt values"
                    onClick={() => onReencrypt(connector)}
                    type="button"
                    variant="secondary"
                  />
                </>
              ) : null}
              <Button label="Cancel" onClick={onClose} type="button" variant="secondary" />
              <form.Subscribe selector={(state) => state.canSubmit}>
                {(canSubmit) => (
                  <Button
                    form={formId}
                    isDisabled={!canSubmit || busy || keys.length === 0}
                    isLoading={saveMutation.isPending}
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

/** Checks whether an OAuth scope belongs to one of the connector's enabled Google APIs. */
function isScopeForEnabledApi({
  id,
  enabledApis,
}: {
  id: string;
  enabledApis: ("gmail" | "calendar")[];
}) {
  const scope = scopeCatalog.find((candidate) => candidate.id === id);
  return Boolean(scope && enabledApis.includes(scope.group.toLowerCase() as "gmail" | "calendar"));
}
/** Validates stable connector identifiers used by URLs, IaC, and CLI selectors. */
function validateIdentity({ value, label }: { value: unknown; label: string }) {
  const key = String(value).trim();
  if (!key) return `${label} is required.`;
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(key))
    return "Use lowercase letters, numbers, dots, dashes, or underscores (120 characters maximum).";
}
/** Validates the human-readable connector name shown across admin and CLI surfaces. */
function validateName(value: unknown) {
  return validateRequired({ value, label: "Name", max: 200 });
}

/** Validates required trimmed connector form fields with a caller-provided size limit. */
function validateRequired({ value, label, max }: { value: unknown; label: string; max: number }) {
  const text = String(value).trim();
  if (!text) return `${label} is required.`;
  if (text.length > max) return `${label} must be ${max.toLocaleString()} characters or less.`;
}
/** Adapts TanStack field state to Astryx input status properties. */
function getFieldStatusProps(field: AnyFieldApi) {
  const status = getFieldStatus(field);
  return status ? { status } : {};
}
/** Returns the first visible validation error for a touched connector field. */
function getFieldStatus(field: AnyFieldApi): { type: "error"; message: string } | undefined {
  const messages = field.state.meta.errors
    .map(getErrorMessage)
    .filter((message): message is string => Boolean(message));
  return field.state.meta.isValid || messages.length === 0
    ? undefined
    : { type: "error", message: messages.join(", ") };
}
/** Normalizes unknown mutation failures for the connector admin dialog. */
function getErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message;
}
