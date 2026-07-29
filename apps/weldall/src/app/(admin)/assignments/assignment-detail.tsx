"use client";

import { useEffect, useId } from "react";
import { useRouter } from "next/navigation";
import type { AnyFieldApi } from "@tanstack/react-form";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { ScopeChecklist } from "../../_components/scope-checklist";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";

export function AssignmentDetail({ assignmentId }: { assignmentId: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
  const isNew = assignmentId === null;
  const assignmentQuery = useQuery({
    ...trpc.admin.assignments.get.queryOptions({ id: assignmentId ?? "new" }),
    enabled: !isNew,
  });
  const scopesQuery = useQuery(trpc.admin.scopes.options.queryOptions());
  const operationToast = useOperationToast();
  const mutation = useMutation(
    trpc.admin.assignments.replace.mutationOptions({
      onSuccess: () =>
        operationToast.success(
          isNew ? "Assignment created" : "Assignment saved",
          "assignment-save",
        ),
      onError: (error) =>
        operationToast.error("Could not save assignment", error, "assignment-save"),
    }),
  );
  const form = useForm({
    defaultValues: {
      email: "",
      scopeKeys: [] as string[],
    },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync({
        email: value.email.trim(),
        scopeKeys: value.scopeKeys,
        expectedVersion: assignmentQuery.data?.version ?? null,
      });
      await queryClient.invalidateQueries();
      router.push("/assignments");
    },
  });

  useEffect(() => {
    if (!assignmentQuery.data) return;
    form.reset({
      email: assignmentQuery.data.email,
      scopeKeys: assignmentQuery.data.scopes,
    });
  }, [assignmentQuery.data, form]);

  const scopes = scopesQuery.data ?? [];

  if (!isNew && assignmentQuery.isPending) {
    return <Text color="secondary">Loading assignment…</Text>;
  }
  if (assignmentQuery.error) {
    return (
      <Banner
        container="card"
        description={assignmentQuery.error.message}
        status="error"
        title="Could not load assignment"
      />
    );
  }

  const assignment = assignmentQuery.data;
  return (
    <>
      <HerocrumbsActions>
        <Button href="/assignments" label="Cancel" variant="secondary" />
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button
              form={formId}
              isDisabled={!canSubmit || scopesQuery.isPending || Boolean(scopesQuery.error)}
              isLoading={mutation.isPending}
              label={isNew ? "Create assignment" : "Save assignment"}
              type="submit"
              variant="primary"
            />
          )}
        </form.Subscribe>
      </HerocrumbsActions>

      <div className="skill-detail-surface">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold">
            {isNew ? "Create assignment" : "Edit assignment"}
          </h2>
          <Text color="secondary">
            Assignments may be created before a user signs in. Saving replaces the complete scope
            set.
          </Text>
        </div>

        {scopesQuery.error ? (
          <Banner
            container="card"
            description={scopesQuery.error.message}
            status="error"
            title="Could not load scopes"
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
              name="email"
              validators={{
                onBlur: ({ value }) => validateEmail(value),
                onChange: ({ value }) => validateEmail(value),
                onSubmit: ({ value }) => validateEmail(value),
              }}
            >
              {(field) => (
                <TextInput
                  isDisabled={!isNew}
                  isRequired
                  label="Email address"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="person@example.com"
                  {...fieldStatusProps(field)}
                  type="email"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>

            <form.Field
              name="scopeKeys"
              validators={{
                onSubmit: ({ value }) =>
                  isNew && value.length === 0 ? "Choose at least one scope." : undefined,
              }}
            >
              {(field) => {
                const error = fieldError(field);
                return (
                  <ScopeChecklist
                    error={error}
                    isLoading={scopesQuery.isPending}
                    onChange={field.handleChange}
                    scopes={scopes}
                    value={field.state.value}
                  />
                );
              }}
            </form.Field>

            {assignment?.scopes.includes("weldall:administer") ? (
              <form.Subscribe selector={(state) => state.values.scopeKeys}>
                {(scopeKeys) =>
                  scopeKeys.includes("weldall:administer") ? null : (
                    <Banner
                      container="card"
                      description="The server rejects this change if it would remove the final administrator."
                      status="warning"
                      title="Administrator access will be removed"
                    />
                  )
                }
              </form.Subscribe>
            ) : null}
          </FormLayout>
        </form>
      </div>
    </>
  );
}

function validateEmail(value: unknown): string | undefined {
  const email = String(value).trim();
  if (!email) return "Email address is required.";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? undefined : "Enter a valid email address.";
}

function fieldStatusProps(field: AnyFieldApi) {
  const error = fieldError(field);
  return error ? { status: { type: "error" as const, message: error } } : {};
}

function fieldError(field: AnyFieldApi): string | undefined {
  const messages = field.state.meta.errors
    .map(errorMessage)
    .filter((message): message is string => Boolean(message));
  return field.state.meta.isValid || messages.length === 0 ? undefined : messages.join(", ");
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return typeof error.message === "string" ? error.message : undefined;
  }
  return undefined;
}
