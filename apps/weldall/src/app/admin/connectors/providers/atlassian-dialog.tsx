"use client";
import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import {
  atlassianConfigSchema,
  presets,
  scopeCatalog,
} from "@/server/connectors/providers/atlassian/config";
import type { ConnectorConfigInput } from "@/server/connectors/contracts";
import { useTRPC } from "@/trpc/react";
import { EnvelopeProviderField } from "../envelope-provider-field";
import type { ConnectorDialogProps } from "../provider-dialog";

type AtlassianInput = Extract<ConnectorConfigInput, { type: "atlassian" }>;
type Props = Omit<ConnectorDialogProps, "connector"> & {
  connector:
    | (Omit<NonNullable<ConnectorDialogProps["connector"]>, "config"> & {
        config: Extract<
          NonNullable<ConnectorDialogProps["connector"]>["config"],
          { type: "atlassian" }
        >;
      })
    | null;
};
/** Atlassian-only configuration stays outside shared connector forms. */
export function AtlassianConnectorDialog({
  connector,
  scopeOptions,
  onClose,
  onDelete,
  onSaved,
}: Props) {
  const trpc = useTRPC();
  const formId = useId();
  const [value, setValue] = useState<AtlassianInput>(
    connector?.config ?? {
      key: "",
      name: "",
      type: "atlassian",
      enabled: false,
      envelopeProvider: "LOCAL_ENV",
      requiredScopes: [],
      provider: {
        clientId: "",
        grantType: "resource",
        products: ["jira"],
        allowedCloudIds: [],
        allowedScopes: presets.jira,
        defaultScopes: presets.jira,
      },
    },
  );
  const [sites, setSites] = useState(value.provider.allowedCloudIds.join("\n"));
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string>();
  const save = useMutation(trpc.admin.managed.saveConnector.mutationOptions());
  const provider = (patch: Partial<AtlassianInput["provider"]>) =>
    setValue((prior) => ({ ...prior, provider: { ...prior.provider, ...patch } }));
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
            title={connector ? "Edit Atlassian connector" : "Add Atlassian connector"}
            subtitle="Resource-level OAuth only. Each connection authorizes one site."
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
                setError(undefined);
                const parsed = atlassianConfigSchema.safeParse({
                  ...value.provider,
                  allowedCloudIds: sites.split(/[\s,]+/).filter(Boolean),
                });
                if (!parsed.success) {
                  setError(parsed.error.issues.map((issue) => issue.message).join(" "));
                  return;
                }
                try {
                  await save.mutateAsync({
                    ...(connector ? { id: connector.id } : {}),
                    version: connector?.version ?? null,
                    config: { ...value, provider: parsed.data },
                    ...(secret ? { providerSecrets: { clientSecret: secret } } : {}),
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
                <TextInput
                  label="OAuth client ID"
                  isRequired
                  value={value.provider.clientId}
                  onChange={(clientId) => provider({ clientId })}
                  width="100%"
                />
                <TextInput
                  label="Client secret"
                  type="password"
                  isRequired={!connector?.secretConfigured}
                  value={secret}
                  onChange={setSecret}
                  placeholder={
                    connector?.secretConfigured
                      ? "Leave empty to keep existing secret"
                      : "Enter client secret"
                  }
                  width="100%"
                />
                <TextArea
                  label="Allowed site cloud IDs"
                  description="Enter one cloud ID per line. Find it at https://your-site.atlassian.net/_edge/tenant_info."
                  isRequired
                  rows={4}
                  value={sites}
                  onChange={setSites}
                  width="100%"
                />
                <MultiSelector
                  label="Products"
                  value={value.provider.products}
                  options={[
                    { value: "jira", label: "Jira Cloud" },
                    { value: "confluence", label: "Confluence Cloud" },
                  ]}
                  onChange={(products) => {
                    const next = products.filter(
                      (product): product is "jira" | "confluence" =>
                        product === "jira" || product === "confluence",
                    );
                    const allowed = value.provider.allowedScopes.filter((id) =>
                      scopeCatalog.some((scope) => scope.id === id && next.includes(scope.product)),
                    );
                    provider({
                      products: next,
                      allowedScopes: allowed,
                      defaultScopes: value.provider.defaultScopes.filter((id) =>
                        allowed.includes(id),
                      ),
                    });
                  }}
                  width="100%"
                />
                <MultiSelector
                  label="Allowed permissions"
                  value={value.provider.allowedScopes}
                  options={scopeCatalog
                    .filter((scope) => value.provider.products.includes(scope.product))
                    .map((scope) => ({
                      value: scope.id,
                      label: scope.mode === "granular" ? `${scope.id} (granular)` : scope.label,
                    }))}
                  onChange={(allowedScopes) =>
                    provider({
                      allowedScopes,
                      defaultScopes: value.provider.defaultScopes.filter((id) =>
                        allowedScopes.includes(id),
                      ),
                    })
                  }
                  hasSearch
                  searchPlaceholder="Search permissions..."
                  width="100%"
                />
                <div className="grid gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Selected by default</span>
                    <Button
                      type="button"
                      label="Select all"
                      variant="ghost"
                      size="sm"
                      isDisabled={
                        value.provider.defaultScopes.length === value.provider.allowedScopes.length
                      }
                      onClick={() => provider({ defaultScopes: [...value.provider.allowedScopes] })}
                    />
                  </div>
                  <MultiSelector
                    label="Selected by default"
                    isLabelHidden
                    value={value.provider.defaultScopes}
                    options={scopeCatalog
                      .filter((scope) => value.provider.allowedScopes.includes(scope.id))
                      .map((scope) => ({
                        value: scope.id,
                        label: scope.mode === "granular" ? `${scope.id} (granular)` : scope.label,
                      }))}
                    onChange={(defaultScopes) => provider({ defaultScopes })}
                    hasSearch
                    searchPlaceholder="Search permissions..."
                    width="100%"
                  />
                </div>
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
                {(error || save.error) && (
                  <Banner
                    status="error"
                    title="Cannot save connector"
                    description={error ?? save.error?.message}
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
