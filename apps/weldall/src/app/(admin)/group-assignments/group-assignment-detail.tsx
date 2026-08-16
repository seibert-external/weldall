"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnyFieldApi } from "@tanstack/react-form";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ManagementBadge } from "@/components/admin/management-badge";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions, HerocrumbsTitle } from "../../_components/herocrumbs";
import { ScopeChecklist } from "../../_components/scope-checklist";
import { useOperationToast } from "../../_components/use-operation-toast";

export function GroupAssignmentDetail({ assignmentId }: { assignmentId: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const isNew = assignmentId === null;
  const operationToast = useOperationToast();
  const assignmentQuery = useQuery({
    ...trpc.admin.groupAssignments.get.queryOptions({ id: assignmentId ?? "new" }),
    enabled: !isNew,
  });
  const providersQuery = useQuery({
    ...trpc.admin.groupProviders.list.queryOptions(),
    enabled: isNew,
  });
  const scopesQuery = useQuery(trpc.admin.scopes.options.queryOptions());
  const deleteMutation = useMutation(
    trpc.admin.groupAssignments.delete.mutationOptions({
      onSuccess: async () => {
        operationToast.success("Group assignment deleted", "group-assignment-delete");
        await queryClient.invalidateQueries();
        router.push("/group-assignments");
      },
      onError: (error) =>
        operationToast.error("Could not delete group assignment", error, "group-assignment-delete"),
    }),
  );
  const createMutation = useMutation(
    trpc.admin.groupAssignments.createMany.mutationOptions({
      onSuccess: () => operationToast.success("Group assignment created", "group-assignment-save"),
      onError: (error) =>
        operationToast.error("Could not create group assignment", error, "group-assignment-save"),
    }),
  );
  const updateMutation = useMutation(
    trpc.admin.groupAssignments.replace.mutationOptions({
      onSuccess: () => operationToast.success("Group assignment saved", "group-assignment-save"),
      onError: (error) =>
        operationToast.error("Could not save group assignment", error, "group-assignment-save"),
    }),
  );
  const mutation = isNew ? createMutation : updateMutation;
  const form = useForm({
    defaultValues: {
      providerId: "",
      groupId: "",
      scopeKeys: [] as string[],
    },
    onSubmit: async ({ value }) => {
      const assignment = assignmentQuery.data;
      if (assignment) {
        await updateMutation.mutateAsync({
          id: assignment.id,
          scopeKeys: value.scopeKeys,
          expectedVersion: assignment.version,
        });
      } else {
        await createMutation.mutateAsync({
          providerId: value.providerId,
          groupIds: [value.groupId.trim()],
          scopeKeys: value.scopeKeys,
        });
      }
      await queryClient.invalidateQueries();
      router.push("/group-assignments");
    },
  });

  useEffect(() => {
    if (!assignmentQuery.data) return;
    form.reset({
      providerId: assignmentQuery.data.providerId,
      groupId: assignmentQuery.data.groupId,
      scopeKeys: assignmentQuery.data.scopes,
    });
  }, [assignmentQuery.data, form]);

  const assignment = assignmentQuery.data;
  const title = isNew
    ? "Create group assignment"
    : assignment
      ? `Edit ${assignment.groupId}`
      : "Edit group assignment";

  if (!isNew && assignmentQuery.isPending) {
    return (
      <>
        <HerocrumbsTitle title={title} />
        <Text color="secondary">Loading group assignment…</Text>
      </>
    );
  }
  if (assignmentQuery.error) {
    return (
      <>
        <HerocrumbsTitle title={title} />
        <Banner
          container="card"
          description={assignmentQuery.error.message}
          status="error"
          title="Could not load group assignment"
        />
      </>
    );
  }

  const scopes = scopesQuery.data ?? [];
  const loadError = (isNew ? providersQuery.error : null) ?? scopesQuery.error ?? null;
  const optionsPending = scopesQuery.isPending || (isNew && providersQuery.isPending);

  return (
    <>
      <HerocrumbsTitle title={title} />
      <HerocrumbsActions>
        {assignment ? (
          <Button
            isDisabled={mutation.isPending || deleteMutation.isPending}
            isLoading={deleteMutation.isPending}
            label="Delete assignment"
            onClick={() => setIsDeleteOpen(true)}
            variant="destructive"
          />
        ) : null}
        <Button href="/group-assignments" label="Cancel" variant="secondary" />
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button
              form={formId}
              isDisabled={
                !canSubmit || optionsPending || Boolean(loadError) || deleteMutation.isPending
              }
              isLoading={mutation.isPending}
              label={isNew ? "Create assignment" : "Save assignment"}
              type="submit"
              variant="primary"
            />
          )}
        </form.Subscribe>
      </HerocrumbsActions>

      <div className="skill-detail-surface">
        {assignmentQuery.data ? (
          <ManagementBadge management={assignmentQuery.data.management} />
        ) : null}
        {mutation.error || loadError ? (
          <Banner
            container="card"
            description={(mutation.error ?? loadError)?.message}
            status="error"
            title={mutation.error ? "Could not save assignment" : "Could not load options"}
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
            {isNew ? (
              <>
                <form.Field
                  name="providerId"
                  validators={{
                    onChange: ({ value }) => requiredSelection(value, "provider"),
                    onSubmit: ({ value }) => requiredSelection(value, "provider"),
                  }}
                >
                  {(field) => (
                    <Selector
                      isLoading={providersQuery.isPending}
                      isRequired
                      label="Provider"
                      onChange={(value) => {
                        field.handleChange(value);
                        form.setFieldValue("groupId", "");
                      }}
                      options={(providersQuery.data ?? []).map((provider) => ({
                        value: provider.id,
                        label: provider.enabled ? provider.name : `${provider.name} (disabled)`,
                      }))}
                      placeholder="Choose a provider…"
                      {...fieldStatusProps(field)}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="groupId"
                  validators={{
                    onBlur: ({ value }) => validateGroupId(value),
                    onChange: ({ value }) => validateGroupId(value),
                    onSubmit: ({ value }) => validateGroupId(value),
                  }}
                >
                  {(field) => (
                    <TextInput
                      isRequired
                      label="Group ID"
                      onBlur={field.handleBlur}
                      onChange={field.handleChange}
                      placeholder="team:finance"
                      {...fieldStatusProps(field)}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
              </>
            ) : null}

            <form.Field
              name="scopeKeys"
              validators={{
                onChange: ({ value }) => requiredList(value, "scope"),
                onSubmit: ({ value }) => requiredList(value, "scope"),
              }}
            >
              {(field) => (
                <ScopeChecklist
                  error={fieldError(field)}
                  isLoading={scopesQuery.isPending}
                  onChange={field.handleChange}
                  scopes={scopes}
                  value={field.state.value}
                />
              )}
            </form.Field>
          </FormLayout>
        </form>
      </div>
      <AlertDialog
        actionLabel="Delete assignment"
        description={
          assignment
            ? `Remove all group-derived scopes for ${assignment.groupId} from ${assignment.providerName}?`
            : "Delete this group assignment?"
        }
        isActionLoading={deleteMutation.isPending}
        isOpen={isDeleteOpen}
        onAction={() => {
          if (assignment && !mutation.isPending) {
            deleteMutation.mutate({ id: assignment.id, expectedVersion: assignment.version });
          }
        }}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            deleteMutation.reset();
            setIsDeleteOpen(false);
          }
        }}
        title="Delete group assignment?"
      />
    </>
  );
}

function validateGroupId(value: string): string | undefined {
  const groupId = value.trim();
  if (!groupId) return "Enter a group ID.";
  return groupId.length <= 191 ? undefined : "Group ID must be 191 characters or fewer.";
}

function requiredSelection(value: unknown, label: string): string | undefined {
  return String(value) ? undefined : `Choose a ${label}.`;
}

function requiredList(value: unknown[], label: string): string | undefined {
  return value.length ? undefined : `Choose at least one ${label}.`;
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
