"use client";

import { useEffect, useId } from "react";
import { useRouter } from "next/navigation";
import type { AnyFieldApi } from "@tanstack/react-form";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";

export function SkillDetail({ skillId }: { skillId: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
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
      hidden: false,
      content: "",
    },
    onSubmit: async ({ value }) => {
      if (skillQuery.data) {
        await updateMutation.mutateAsync({
          id: skillQuery.data.id,
          title: value.title.trim(),
          content: value.content.trim(),
          requiredScopes: value.requiredScopes,
          hidden: value.hidden,
          expectedVersion: skillQuery.data.version,
        });
      } else {
        await createMutation.mutateAsync({
          slug: value.slug.trim(),
          title: value.title.trim(),
          content: value.content.trim(),
          requiredScopes: value.requiredScopes,
          hidden: value.hidden,
        });
      }
      await queryClient.invalidateQueries();
      router.push("/skills");
    },
  });

  useEffect(() => {
    if (!skillQuery.data) return;
    form.reset({
      slug: skillQuery.data.slug,
      title: skillQuery.data.title,
      requiredScopes: skillQuery.data.requiredScopes,
      hidden: skillQuery.data.hidden,
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
  return (
    <>
      <HerocrumbsActions>
        <Button href="/skills" label="Cancel" variant="secondary" />
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button
              form={formId}
              isDisabled={!canSubmit}
              isLoading={mutation.isPending}
              label={isNew ? "Create skill" : "Save skill"}
              type="submit"
              variant="primary"
            />
          )}
        </form.Subscribe>
      </HerocrumbsActions>

      <div className="skill-detail-surface">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold">
            {isNew ? "Create skill" : skillQuery.data?.title}
          </h2>
          <Text color="secondary">
            Metadata is emitted as frontmatter; the instructions remain plain Markdown.
          </Text>
        </div>

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
                  isDisabled={!isNew}
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
                  hasSearch
                  hasSelectAll
                  label="Required scopes"
                  onChange={field.handleChange}
                  options={scopes.map((scope) => ({ value: scope.key, label: scope.key }))}
                  placeholder="Choose scopes…"
                  renderOption={(option) => {
                    const scope = scopes.find((candidate) => candidate.key === option.value);
                    return (
                      <div className="grid gap-0.5">
                        <span>{option.label ?? option.value}</span>
                        {scope ? (
                          <span className="text-xs text-[var(--color-text-secondary)]">
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
            <form.Field name="hidden">
              {(field) => (
                <Switch
                  description="Hide this skill completely when the user lacks any required scope."
                  label="Hidden without required scopes"
                  labelPosition="start"
                  labelSpacing="spread"
                  onChange={field.handleChange}
                  value={field.state.value}
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
    </>
  );
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
