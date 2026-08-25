"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnyFieldApi } from "@tanstack/react-form";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ManagementBadge } from "@/components/admin/management-badge";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";

const catalogStatuses = {
  fresh: { icon: "success", color: "success", label: "Fresh" },
  stale: { icon: "warning", color: "warning", label: "Stale" },
  failed: { icon: "error", color: "error", label: "Failed" },
  expired: { icon: "error", color: "error", label: "Expired" },
  pending: { icon: "info", color: "accent", label: "Pending" },
  disabled: { icon: "info", color: "accent", label: "Disabled" },
} as const;

export function ResourceDetail({ resourceId }: { resourceId: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
  const isNew = resourceId === null;
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const resourceQuery = useQuery({
    ...trpc.admin.resources.get.queryOptions({ id: resourceId ?? "new" }),
    enabled: !isNew,
  });
  const scopeOptionsQuery = useQuery(trpc.admin.scopes.options.queryOptions());
  const operationToast = useOperationToast();
  const createMutation = useMutation(
    trpc.admin.resources.create.mutationOptions({
      onSuccess: () => operationToast.success("Resource created", "resource-save"),
      onError: (error) => operationToast.error("Could not create resource", error, "resource-save"),
    }),
  );
  const updateMutation = useMutation(
    trpc.admin.resources.update.mutationOptions({
      onSuccess: () => operationToast.success("Resource saved", "resource-save"),
      onError: (error) => operationToast.error("Could not save resource", error, "resource-save"),
    }),
  );
  const deleteMutation = useMutation(
    trpc.admin.resources.delete.mutationOptions({
      onSuccess: async () => {
        operationToast.success("Resource deleted", "resource-delete");
        await queryClient.invalidateQueries();
        router.push("/admin/resources");
      },
      onError: async (error) => {
        operationToast.error("Could not delete resource", error, "resource-delete");
        await queryClient.invalidateQueries();
      },
    }),
  );
  const refreshSkillsMutation = useMutation(
    trpc.admin.resources.refreshSkills.mutationOptions({
      onSuccess: async (outcome) => {
        await queryClient.invalidateQueries();
        if (outcome === "succeeded") {
          operationToast.success("Skills reloaded", "resource-skills-refresh");
          return;
        }
        const detail =
          outcome === "already_running"
            ? "A refresh is already running"
            : outcome === "unavailable"
              ? "Skill discovery is disabled for this resource"
              : "The refresh failed; see the discovery status for details";
        operationToast.error(
          "Could not reload skills",
          new Error(detail),
          "resource-skills-refresh",
        );
      },
      onError: (error) =>
        operationToast.error("Could not reload skills", error, "resource-skills-refresh"),
    }),
  );
  const mutation = isNew ? createMutation : updateMutation;
  const form = useForm({
    defaultValues: {
      key: "",
      name: "",
      resourceIdentifier: "",
      authorizationServer: "",
      downstreamClientId: "",
      requestPrefixes: "",
      scopeIds: [] as string[],
      enabled: true,
      skillDiscoveryEnabled: false,
    },
    onSubmit: async ({ value }) => {
      const requestPrefixes = parsePrefixLines(value.requestPrefixes);
      if (resourceQuery.data) {
        await updateMutation.mutateAsync({
          id: resourceQuery.data.id,
          name: value.name.trim(),
          authorizationServer: value.authorizationServer.trim(),
          downstreamClientId: value.downstreamClientId.trim(),
          requestPrefixes,
          scopeIds: value.scopeIds,
          enabled: value.enabled,
          skillDiscoveryEnabled: value.skillDiscoveryEnabled,
          expectedVersion: resourceQuery.data.version,
        });
      } else {
        await createMutation.mutateAsync({
          key: value.key.trim(),
          name: value.name.trim(),
          resourceIdentifier: value.resourceIdentifier.trim(),
          authorizationServer: value.authorizationServer.trim(),
          downstreamClientId: value.downstreamClientId.trim(),
          requestPrefixes,
          scopeIds: value.scopeIds,
          enabled: value.enabled,
          skillDiscoveryEnabled: value.skillDiscoveryEnabled,
        });
      }
      await queryClient.invalidateQueries();
      router.push("/admin/resources");
    },
  });

  useEffect(() => {
    if (!resourceQuery.data) return;
    form.reset({
      key: resourceQuery.data.key,
      name: resourceQuery.data.name,
      resourceIdentifier: resourceQuery.data.resourceIdentifier,
      authorizationServer: resourceQuery.data.authorizationServer,
      downstreamClientId: resourceQuery.data.downstreamClientId,
      requestPrefixes: resourceQuery.data.requestPrefixes.join("\n"),
      scopeIds: resourceQuery.data.scopeIds,
      enabled: resourceQuery.data.enabled,
      skillDiscoveryEnabled: resourceQuery.data.skillDiscoveryEnabled,
    });
  }, [form, resourceQuery.data]);

  if (!isNew && resourceQuery.isPending) return <Text color="secondary">Loading resource…</Text>;
  if (resourceQuery.error) {
    return (
      <Banner
        container="card"
        status="error"
        title="Could not load resource"
        description={resourceQuery.error.message}
      />
    );
  }
  const scopeOptions = scopeOptionsQuery.data ?? [];
  const current = resourceQuery.data;

  return (
    <>
      <HerocrumbsActions>
        {current ? (
          <HStack gap={1} vAlign="center">
            <Button
              href={`/admin/skills?source=${encodeURIComponent(current.id)}`}
              label={`View skills (${current.catalogStatus?.skillCount ?? 0})`}
              variant="secondary"
            />
          </HStack>
        ) : null}
        {current ? (
          <Button
            isDisabled={
              !current.enabled ||
              !current.skillDiscoveryEnabled ||
              mutation.isPending ||
              deleteMutation.isPending
            }
            isLoading={refreshSkillsMutation.isPending}
            label="Reload skills"
            onClick={() => refreshSkillsMutation.mutate({ id: current.id })}
            type="button"
            variant="secondary"
          />
        ) : null}
        {current ? (
          <Button
            isDisabled={mutation.isPending || refreshSkillsMutation.isPending}
            label="Delete resource"
            onClick={() => setIsDeleteOpen(true)}
            type="button"
            variant="destructive"
          />
        ) : null}
        <Button href="/admin/resources" label="Cancel" variant="secondary" />
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button
              form={formId}
              isDisabled={!canSubmit || deleteMutation.isPending || refreshSkillsMutation.isPending}
              isLoading={mutation.isPending}
              label={isNew ? "Create resource" : "Save resource"}
              type="submit"
              variant="primary"
            />
          )}
        </form.Subscribe>
      </HerocrumbsActions>
      <div className="skill-detail-surface">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold">{isNew ? "Create resource" : current?.name}</h2>
          {current ? <ManagementBadge management={current.management} /> : null}
          <Text color="secondary">
            {current
              ? `Version ${current.version} · Updated ${new Date(
                  current.updatedAt,
                ).toLocaleString()}`
              : "Register an OAuth resource and the HTTPS request areas it accepts."}
          </Text>
        </div>
        {current?.catalogStatus ? (
          <div className="grid gap-1">
            <HStack gap={2} vAlign="center">
              <Icon
                icon={catalogStatuses[current.catalogStatus.state].icon}
                color={catalogStatuses[current.catalogStatus.state].color}
                size="sm"
              />
              <Text type="body">
                Skill discovery: {catalogStatuses[current.catalogStatus.state].label}
              </Text>
            </HStack>
            <Text color="secondary" type="body">
              {`Discovered skills: ${current.catalogStatus.skillCount} · Last attempt: ${
                current.catalogStatus.lastAttemptAt
                  ? new Date(current.catalogStatus.lastAttemptAt).toLocaleString()
                  : "never"
              } · Last successful refresh: ${
                current.catalogStatus.lastSuccessfulRefreshAt
                  ? new Date(current.catalogStatus.lastSuccessfulRefreshAt).toLocaleString()
                  : "never"
              }${
                current.catalogStatus.lastFailureCategory
                  ? ` · Last failure: ${current.catalogStatus.lastFailureCategory} at ${
                      current.catalogStatus.lastFailureAt
                        ? new Date(current.catalogStatus.lastFailureAt).toLocaleString()
                        : "unknown"
                    }`
                  : ""
              }`}
            </Text>
          </div>
        ) : null}
        {scopeOptionsQuery.error ? (
          <Banner
            container="card"
            status="error"
            title="Could not load scopes"
            description={scopeOptionsQuery.error.message}
          />
        ) : null}
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
            <form.Field name="key" validators={{ onSubmit: ({ value }) => validateKey(value) }}>
              {(field) => (
                <TextInput
                  isDisabled={!isNew}
                  isRequired
                  label="Resource key"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="expenses"
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="name"
              validators={{
                onSubmit: ({ value }) => required(value, "Name", 200),
              }}
            >
              {(field) => (
                <TextInput
                  isRequired
                  label="Name"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="Expenses"
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="resourceIdentifier"
              validators={{
                onSubmit: ({ value }) => validateHttps(value, "Resource identifier"),
              }}
            >
              {(field) => (
                <TextInput
                  isDisabled={!isNew}
                  isRequired
                  label="Resource identifier"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="https://expenses.example/api"
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="authorizationServer"
              validators={{ onSubmit: ({ value }) => validateOrigin(value) }}
            >
              {(field) => (
                <TextInput
                  isRequired
                  label="Authorization server"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="https://expenses.example"
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="downstreamClientId"
              validators={{
                onSubmit: ({ value }) => required(value, "Downstream client ID", 200),
              }}
            >
              {(field) => (
                <TextInput
                  isRequired
                  label="Downstream client ID"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="weldall-cli-at-expenses"
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="requestPrefixes"
              validators={{ onSubmit: ({ value }) => validatePrefixes(value) }}
            >
              {(field) => (
                <TextArea
                  isRequired
                  label="Request prefixes"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="https://expenses.example/api"
                  rows={5}
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                />
              )}
            </form.Field>
            <form.Field name="scopeIds">
              {(field) => (
                <MultiSelector
                  hasClear
                  hasSearch
                  hasSelectAll
                  label="Supported scopes"
                  onChange={field.handleChange}
                  options={scopeOptions.map((scope) => ({
                    value: scope.id,
                    label: scope.key,
                  }))}
                  placeholder="Choose scopes…"
                  searchPlaceholder="Find scopes…"
                  triggerDisplay="badges"
                  value={field.state.value}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="enabled">
              {(field) => (
                <Switch
                  description="Disabled resources are hidden from the CLI and rejected during token exchange."
                  label="Enabled"
                  labelPosition="start"
                  labelSpacing="spread"
                  onChange={field.handleChange}
                  value={field.state.value}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="skillDiscoveryEnabled">
              {(field) => (
                <Switch
                  description="Trust this resource to publish read-only agent instructions. Discovered documents and refresh status are stored in PostgreSQL."
                  label="Discover skills from this resource"
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
      </div>
      <AlertDialog
        actionLabel="Delete resource"
        description={
          current
            ? `Delete ${current.name}? Its request prefixes and discovered skills will be removed immediately.`
            : "Delete this resource?"
        }
        isActionLoading={deleteMutation.isPending}
        isOpen={isDeleteOpen}
        onAction={() => {
          if (current) {
            deleteMutation.mutate({ id: current.id, expectedVersion: current.version });
          }
        }}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            deleteMutation.reset();
            setIsDeleteOpen(false);
          }
        }}
        title="Delete resource?"
      />
    </>
  );
}

const parsePrefixLines = (value: string) => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

function validateKey(value: unknown) {
  const key = String(value).trim();
  if (!key) return "Resource key is required.";
  if (!/^[a-z0-9._-]+$/.test(key))
    return "Use lowercase letters, numbers, dots, dashes, or underscores.";
  return key.length <= 120 ? undefined : "Resource key must be 120 characters or less.";
}

function required(value: unknown, label: string, max: number) {
  const text = String(value).trim();
  if (!text) return `${label} is required.`;
  return text.length <= max ? undefined : `${label} must be ${max} characters or less.`;
}

function validateHttps(value: unknown, label: string) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      ? undefined
      : `${label} must be an HTTPS URL without credentials or a fragment.`;
  } catch {
    return `${label} must be an absolute HTTPS URL.`;
  }
}

function validateOrigin(value: unknown) {
  const error = validateHttps(value, "Authorization server");
  if (error) return error;
  const url = new URL(String(value).trim());
  return url.pathname === "/" && !url.search && !url.hash
    ? undefined
    : "Authorization server must be an HTTPS origin without path, query, or fragment.";
}

function validatePrefixes(value: unknown) {
  const prefixes = parsePrefixLines(String(value));
  if (!prefixes.length) return "At least one request prefix is required.";
  for (const prefix of prefixes) {
    const error = validateHttps(prefix, "Request prefix");
    if (error) return error;
    const url = new URL(prefix);
    if (url.search || url.hash) return "Request prefixes must not contain a query or fragment.";
  }
  return undefined;
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
