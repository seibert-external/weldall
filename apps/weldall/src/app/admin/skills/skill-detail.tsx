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
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ManagementBadge } from "@/components/admin/management-badge";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions, HerocrumbsTitle } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";

const catalogStatuses = {
  fresh: { icon: "success", color: "success", label: "Fresh" },
  stale: { icon: "warning", color: "warning", label: "Stale" },
  failed: { icon: "error", color: "error", label: "Failed" },
  expired: { icon: "error", color: "error", label: "Expired" },
  pending: { icon: "info", color: "accent", label: "Pending" },
  disabled: { icon: "info", color: "accent", label: "Disabled" },
} as const;

export function SkillDetail({
  skillId,
  iconOptions,
}: {
  skillId: string | null;
  iconOptions: string[];
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const isNew = skillId === null;
  const skillQuery = useQuery({
    ...trpc.admin.skills.get.queryOptions({ id: skillId ?? "new" }),
    enabled: !isNew,
  });
  const scopeOptionsQuery = useQuery(trpc.admin.scopes.options.queryOptions());
  const operationToast = useOperationToast();
  const createMutation = useMutation(
    trpc.admin.skills.create.mutationOptions({
      onSuccess: () => operationToast.success("Skill created", "skill-save"),
      onError: (error) => operationToast.error("Could not create skill", error, "skill-save"),
    }),
  );
  const deleteMutation = useMutation(
    trpc.admin.skills.delete.mutationOptions({
      onSuccess: async () => {
        operationToast.success("Skill deleted", "skill-delete");
        await queryClient.invalidateQueries();
        router.push("/admin/skills");
      },
      onError: (error) => operationToast.error("Could not delete skill", error, "skill-delete"),
    }),
  );
  const updateMutation = useMutation(
    trpc.admin.skills.update.mutationOptions({
      onSuccess: () => operationToast.success("Skill saved", "skill-save"),
      onError: (error) => operationToast.error("Could not save skill", error, "skill-save"),
    }),
  );
  const mutation = isNew ? createMutation : updateMutation;
  const form = useForm({
    defaultValues: {
      slug: "",
      title: "",
      requiredScopes: [] as string[],
      visibility: "DEFAULT" as "DEFAULT" | "HIDDEN_IF_UNALLOWED",
      tags: "",
      owner: "",
      icon: "",
      gradientFrom: "",
      gradientTo: "",
      darkGradientFrom: "",
      darkGradientTo: "",
      lastUpdatedAt: "",
      content: "",
    },
    onSubmit: async ({ value }) => {
      const meta = skillMetaFromForm(
        value.tags,
        value.owner,
        {
          icon: value.icon,
          gradientFrom: value.gradientFrom,
          gradientTo: value.gradientTo,
          darkGradientFrom: value.darkGradientFrom,
          darkGradientTo: value.darkGradientTo,
        },
        skillQuery.data?.meta?.appearance,
      );
      const optionalFields = {
        ...(meta ? { meta } : {}),
        ...(value.lastUpdatedAt !== "" ? { lastUpdatedAt: value.lastUpdatedAt } : {}),
      };
      if (skillQuery.data) {
        await updateMutation.mutateAsync({
          id: skillQuery.data.id,
          title: value.title.trim(),
          content: value.content.trim(),
          requiredScopes: value.requiredScopes,
          visibility: value.visibility,
          ...optionalFields,
          expectedVersion: skillQuery.data.version,
        });
      } else {
        await createMutation.mutateAsync({
          slug: value.slug.trim(),
          title: value.title.trim(),
          content: value.content.trim(),
          requiredScopes: value.requiredScopes,
          visibility: value.visibility,
          ...optionalFields,
        });
      }
      await queryClient.invalidateQueries();
      router.push("/admin/skills");
    },
  });

  useEffect(() => {
    if (!skillQuery.data) return;
    form.reset({
      slug: skillQuery.data.slug,
      title: skillQuery.data.title,
      requiredScopes: skillQuery.data.requiredScopes,
      visibility: skillQuery.data.visibility,
      tags: skillQuery.data.meta?.tags?.join("\n") ?? "",
      owner: skillQuery.data.meta?.owner ?? "",
      icon: skillQuery.data.meta?.appearance?.icon ?? "",
      gradientFrom: skillQuery.data.meta?.appearance?.gradientFrom ?? "",
      gradientTo: skillQuery.data.meta?.appearance?.gradientTo ?? "",
      darkGradientFrom: skillQuery.data.meta?.appearance?.darkGradientFrom ?? "",
      darkGradientTo: skillQuery.data.meta?.appearance?.darkGradientTo ?? "",
      lastUpdatedAt: skillQuery.data.lastUpdatedAt ?? "",
      content: skillQuery.data.content,
    });
  }, [form, skillQuery.data]);

  if (!isNew && skillQuery.isPending) {
    return <Text color="secondary">Loading skill…</Text>;
  }
  if (skillQuery.error) {
    return (
      <Banner
        container="card"
        status="error"
        title="Could not load skill"
        description={skillQuery.error.message}
      />
    );
  }

  const scopes = scopeOptionsQuery.data ?? [];
  const isReadOnly = skillQuery.data?.readOnly ?? false;
  return (
    <>
      <HerocrumbsTitle title={isNew ? "Create skill" : (skillQuery.data?.title ?? "Skill")} />
      <HerocrumbsActions>
        {!isNew && !isReadOnly ? (
          <Button
            isDisabled={mutation.isPending || deleteMutation.isPending}
            isLoading={deleteMutation.isPending}
            label="Delete skill"
            onClick={() => setIsDeleteOpen(true)}
            variant="destructive"
          />
        ) : null}
        <Button href="/admin/skills" label="Cancel" variant="secondary" />
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) =>
            isReadOnly ? null : (
              <Button
                form={formId}
                isDisabled={!canSubmit || deleteMutation.isPending}
                isLoading={mutation.isPending}
                label={isNew ? "Create skill" : "Save skill"}
                type="submit"
                variant="primary"
              />
            )
          }
        </form.Subscribe>
      </HerocrumbsActions>

      <div className="skill-detail-surface">
        {!isNew && skillQuery.data?.source.type === "manual" ? (
          <ManagementBadge management={skillQuery.data.management} />
        ) : null}
        {isReadOnly && skillQuery.data?.source.type === "resource" ? (
          <div className="grid gap-1">
            <HStack gap={2} vAlign="center">
              <Icon icon="info" color="accent" size="sm" />
              <Text type="body">Published by {skillQuery.data.source.name}</Text>
            </HStack>
            <HStack gap={2} vAlign="center">
              <Icon
                icon={catalogStatuses[skillQuery.data.source.catalogState].icon}
                color={catalogStatuses[skillQuery.data.source.catalogState].color}
                size="sm"
              />
              <Text type="body">
                {`Catalog: ${catalogStatuses[skillQuery.data.source.catalogState].label}${
                  skillQuery.data.disabled
                    ? ". Discovery is disabled; this persisted skill is not available to users."
                    : ""
                }${
                  skillQuery.data.scopeWarnings.length
                    ? `. ${skillQuery.data.scopeWarnings.join(" · ")}`
                    : ""
                }${skillQuery.data.overridden ? ". Overridden by a manual skill." : ""}`}
              </Text>
            </HStack>
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
            <form.Field
              name="slug"
              validators={{
                onBlur: ({ value }) => validateSlug(value),
                onChange: ({ value }) => validateSlug(value),
                onSubmit: ({ value }) => validateSlug(value),
              }}
            >
              {(field) => (
                <TextInput
                  isDisabled={!isNew || isReadOnly}
                  isRequired
                  label="Skill ID"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="expenses.list"
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="title"
              validators={{
                onBlur: ({ value }) => validateRequiredText(value, "Title", 200),
                onSubmit: ({ value }) => validateRequiredText(value, "Title", 200),
              }}
            >
              {(field) => (
                <TextInput
                  isDisabled={isReadOnly}
                  isRequired
                  label="Title"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="Load expenses"
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="requiredScopes">
              {(field) => (
                <MultiSelector
                  hasClear
                  isDisabled={isReadOnly}
                  hasSearch
                  hasSelectAll
                  label="Required scopes"
                  onChange={field.handleChange}
                  options={scopes.map((scope) => ({
                    value: scope.key,
                    label: scope.key,
                  }))}
                  placeholder="Choose scopes…"
                  renderOption={(option) => {
                    const scope = scopes.find((candidate) => candidate.key === option.value);
                    return (
                      <div className="admin-dropdown-option">
                        <span>{option.label ?? option.value}</span>
                        {scope ? (
                          <span className="admin-dropdown-option-subtitle">
                            {scope.description}
                          </span>
                        ) : null}
                      </div>
                    );
                  }}
                  searchPlaceholder="Find scopes…"
                  triggerDisplay="badges"
                  value={field.state.value}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="visibility">
              {(field) => (
                <Selector
                  isDisabled={isReadOnly}
                  label="Visibility"
                  onChange={(value) =>
                    field.handleChange(value as "DEFAULT" | "HIDDEN_IF_UNALLOWED")
                  }
                  options={[
                    { value: "DEFAULT", label: "Default" },
                    {
                      value: "HIDDEN_IF_UNALLOWED",
                      label: "Hidden if unallowed",
                    },
                  ]}
                  value={field.state.value}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="tags">
              {(field) => (
                <TextArea
                  isDisabled={isReadOnly}
                  label="Tags (one per line)"
                  onChange={field.handleChange}
                  placeholder={"automation\nfinance"}
                  rows={4}
                  value={String(field.state.value)}
                />
              )}
            </form.Field>
            <form.Field name="owner">
              {(field) => (
                <TextInput
                  isDisabled={isReadOnly}
                  label="Owner user ID"
                  onChange={field.handleChange}
                  placeholder="user-id"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="icon">
              {(field) => {
                const value = String(field.state.value);
                const query = value.trim().toLocaleLowerCase();
                const suggestions = query
                  ? iconOptions.filter((name) => name !== value && name.includes(query)).slice(0, 8)
                  : [];
                const isKnownIcon = iconOptions.includes(value);
                return (
                  <div className="skill-icon-picker">
                    <TextInput
                      description="Canonical Lucide icon name; unknown values use the slug-hashed fallback."
                      hasClear
                      isDisabled={isReadOnly}
                      label="Card icon"
                      labelTooltip="Browse available names at lucide.dev/icons"
                      onChange={field.handleChange}
                      placeholder="file-text"
                      startIcon={
                        isKnownIcon ? (
                          <img
                            alt=""
                            aria-hidden="true"
                            height={16}
                            src={`/api/lucide-icons/${encodeURIComponent(value)}`}
                            width={16}
                          />
                        ) : undefined
                      }
                      value={value}
                      width="100%"
                    />
                    {suggestions.length ? (
                      <div aria-label="Matching Lucide icons" className="skill-icon-suggestions">
                        {suggestions.map((name) => (
                          <Button
                            icon={
                              <img
                                alt=""
                                aria-hidden="true"
                                height={16}
                                src={`/api/lucide-icons/${encodeURIComponent(name)}`}
                                width={16}
                              />
                            }
                            key={name}
                            label={`Use ${name}`}
                            onClick={() => field.handleChange(name)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {name}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              }}
            </form.Field>
            <form.Field name="gradientFrom">
              {(field) => (
                <TextInput
                  isDisabled={isReadOnly}
                  label="Light gradient from"
                  onChange={field.handleChange}
                  placeholder="#555BD6"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="gradientTo">
              {(field) => (
                <TextInput
                  isDisabled={isReadOnly}
                  label="Light gradient to"
                  onChange={field.handleChange}
                  placeholder="#7773E5"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="darkGradientFrom">
              {(field) => (
                <TextInput
                  isDisabled={isReadOnly}
                  label="Dark gradient from"
                  onChange={field.handleChange}
                  placeholder="#2A2660"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="darkGradientTo">
              {(field) => (
                <TextInput
                  isDisabled={isReadOnly}
                  label="Dark gradient to"
                  onChange={field.handleChange}
                  placeholder="#403A86"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field name="lastUpdatedAt">
              {(field) => (
                <TextInput
                  isDisabled={isReadOnly}
                  label="Last updated at"
                  onChange={field.handleChange}
                  placeholder="2026-06-25T12:00:00Z"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="content"
              validators={{
                onBlur: ({ value }) => validateRequiredText(value, "Markdown", 100_000),
                onSubmit: ({ value }) => validateRequiredText(value, "Markdown", 100_000),
              }}
            >
              {(field) => (
                <TextArea
                  isDisabled={isReadOnly}
                  isRequired
                  label="Markdown instructions"
                  maxLength={100_000}
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder={
                    "Use `weldall request --scope expenses:read https://…` to load expenses.\n\nThis is useful when…"
                  }
                  rows={22}
                  {...fieldStatusProps(field)}
                  value={String(field.state.value)}
                />
              )}
            </form.Field>
          </FormLayout>
        </form>
      </div>
      <AlertDialog
        actionLabel="Delete skill"
        description={
          skillQuery.data
            ? `Delete ${skillQuery.data.title}? Agents will no longer be able to discover it.`
            : "Delete this skill?"
        }
        isActionLoading={deleteMutation.isPending}
        isOpen={isDeleteOpen}
        onAction={() => {
          if (skillQuery.data && !skillQuery.data.readOnly && !mutation.isPending) {
            deleteMutation.mutate({
              id: skillQuery.data.id,
              expectedVersion: skillQuery.data.version,
            });
          }
        }}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            deleteMutation.reset();
            setIsDeleteOpen(false);
          }
        }}
        title="Delete skill?"
      />
    </>
  );
}

const recognizedAppearanceKeys = new Set([
  "icon",
  "gradientFrom",
  "gradientTo",
  "darkGradientFrom",
  "darkGradientTo",
]);

function skillMetaFromForm(
  tags: string,
  owner: string,
  appearanceFields: Record<string, string>,
  existingAppearance?: Record<string, string>,
) {
  const appearance = {
    ...Object.fromEntries(
      Object.entries(existingAppearance ?? {}).filter(
        ([key]) => !recognizedAppearanceKeys.has(key),
      ),
    ),
    ...Object.fromEntries(Object.entries(appearanceFields).filter(([, value]) => value !== "")),
  };
  if (tags === "" && owner === "" && Object.keys(appearance).length === 0) return undefined;
  return {
    ...(tags !== "" ? { tags: tags.split("\n") } : {}),
    ...(owner !== "" ? { owner } : {}),
    ...(Object.keys(appearance).length ? { appearance } : {}),
  };
}

function validateSlug(value: unknown): string | undefined {
  const slug = String(value).trim();
  if (!slug) return "Skill ID is required.";
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(slug)) {
    return "Use lowercase letters, numbers, dots, dashes, or underscores.";
  }
  return slug.length <= 120 ? undefined : "Skill ID must be 120 characters or less.";
}

function validateRequiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value).trim();
  if (!text) return `${label} is required.`;
  return text.length <= maxLength ? undefined : `${label} must be ${maxLength} characters or less.`;
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
