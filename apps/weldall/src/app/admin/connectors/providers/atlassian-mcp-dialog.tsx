"use client";
import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { ATLASSIAN_MCP_SCOPES } from "@weldall/sdk/mcp";
import type { ConnectorConfigInput } from "@/server/connectors/contracts";
import { useTRPC } from "@/trpc/react";
import { EnvelopeProviderField } from "../envelope-provider-field";
import type { ConnectorDialogProps } from "../provider-dialog";

type McpInput = Extract<ConnectorConfigInput, { type: "atlassian-mcp" }>;
type Props = Omit<ConnectorDialogProps, "connector"> & {
  connector: (NonNullable<ConnectorDialogProps["connector"]> & { config: McpInput }) | null;
};
export function AtlassianMcpConnectorDialog({
  connector,
  scopeOptions,
  onClose,
  onDelete,
  onSaved,
}: Props) {
  const trpc = useTRPC();
  const formId = useId();
  const [value, setValue] = useState<McpInput>(
    connector?.config ?? {
      key: "",
      name: "Atlassian MCP",
      type: "atlassian-mcp",
      enabled: false,
      envelopeProvider: "LOCAL_ENV",
      requiredScopes: [],
      provider: {
        allowedScopes: ["read:jira:agent-interface"],
        defaultScopes: ["read:jira:agent-interface"],
      },
    },
  );
  const save = useMutation(trpc.admin.managed.saveConnector.mutationOptions());
  const close = () => {
    if (!save.isPending) onClose();
  };
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      purpose="form"
      width="min(760px, calc(100vw - 32px))"
    >
      <Layout
        header={
          <DialogHeader
            title={connector ? "Edit Atlassian MCP connector" : "Add Atlassian MCP connector"}
            subtitle="The endpoint is built in. OAuth client registration happens automatically when the first user connects; no client ID or secret is needed."
            onOpenChange={(open) => {
              if (!open) close();
            }}
          />
        }
        content={
          <LayoutContent>
            <form
              id={formId}
              className="admin-dialog-form"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  await save.mutateAsync({
                    ...(connector ? { id: connector.id } : {}),
                    version: connector?.version ?? null,
                    config: value,
                  });
                  await onSaved();
                } catch {
                  /* Mutation renders the sanitized server error below. */
                }
              }}
            >
              <FormLayout>
                <TextInput
                  label="Connector key"
                  isRequired
                  isDisabled={Boolean(connector)}
                  value={value.key}
                  onChange={(key) => setValue({ ...value, key })}
                  width="100%"
                />
                <TextInput
                  label="Name"
                  isRequired
                  value={value.name}
                  onChange={(name) => setValue({ ...value, name })}
                  width="100%"
                />
                <MultiSelector
                  label="Allowed permissions"
                  value={value.provider.allowedScopes}
                  options={ATLASSIAN_MCP_SCOPES.map((scope) => ({ value: scope, label: scope }))}
                  onChange={(selected) => {
                    const allowedScopes = ATLASSIAN_MCP_SCOPES.filter((scope) =>
                      selected.includes(scope),
                    );
                    setValue({
                      ...value,
                      provider: {
                        allowedScopes,
                        defaultScopes: value.provider.defaultScopes.filter((scope) =>
                          allowedScopes.includes(scope),
                        ),
                      },
                    });
                  }}
                  width="100%"
                />
                <MultiSelector
                  label="Selected by default"
                  value={value.provider.defaultScopes}
                  options={value.provider.allowedScopes.map((scope) => ({
                    value: scope,
                    label: scope,
                  }))}
                  onChange={(selected) =>
                    setValue({
                      ...value,
                      provider: {
                        ...value.provider,
                        defaultScopes: value.provider.allowedScopes.filter((scope) =>
                          selected.includes(scope),
                        ),
                      },
                    })
                  }
                  width="100%"
                />
                <MultiSelector
                  label="Required Weldall scopes"
                  value={value.requiredScopes}
                  options={scopeOptions.map((scope) => ({ value: scope.key, label: scope.key }))}
                  onChange={(requiredScopes) => setValue({ ...value, requiredScopes })}
                  width="100%"
                />
                <EnvelopeProviderField
                  existing={Boolean(connector)}
                  value={value.envelopeProvider}
                  onChange={(envelopeProvider) => setValue({ ...value, envelopeProvider })}
                />
                <Switch
                  label="Enabled"
                  value={value.enabled}
                  onChange={(enabled) => setValue({ ...value, enabled })}
                />
                {save.error && (
                  <Banner
                    status="error"
                    title="Cannot save connector"
                    description={save.error.message}
                  />
                )}
              </FormLayout>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex w-full justify-end gap-2">
              {connector && (
                <Button
                  type="button"
                  label="Delete connector"
                  variant="destructive"
                  isDisabled={save.isPending}
                  onClick={() => onDelete(connector)}
                />
              )}
              <Button
                type="button"
                label="Cancel"
                variant="secondary"
                isDisabled={save.isPending}
                onClick={close}
              />
              <Button
                type="submit"
                form={formId}
                label="Save connector"
                isLoading={save.isPending}
                isDisabled={save.isPending}
              />
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
