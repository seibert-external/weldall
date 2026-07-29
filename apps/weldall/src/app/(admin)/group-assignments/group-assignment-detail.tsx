"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnyFieldApi } from "@tanstack/react-form";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { Typeahead, type SearchSource } from "@astryxdesign/core/Typeahead";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions, HerocrumbsTitle } from "../../_components/herocrumbs";
import { ScopeChecklist } from "../../_components/scope-checklist";
import { useOperationToast } from "../../_components/use-operation-toast";

interface ProviderGroupTypeaheadItem {
  id: string;
  label: string;
  auxiliaryData: { description?: string };
}

export function GroupAssignmentDetail({ assignmentId }: { assignmentId: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
  const isNew = assignmentId === null;
  const operationToast = useOperationToast();
  const [groupSearchError, setGroupSearchError] = useState<Error | null>(null);
  const assignmentQuery = useQuery({
    ...trpc.admin.groupAssignments.get.queryOptions({ id: assignmentId ?? "new" }),
    enabled: !isNew,
  });
  const providersQuery = useQuery({
    ...trpc.admin.groupProviders.list.queryOptions(),
    enabled: isNew,
  });
  const scopesQuery = useQuery(trpc.admin.scopes.options.queryOptions());
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
      group: null as ProviderGroupTypeaheadItem | null,
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
        if (!value.group) return;
        await createMutation.mutateAsync({
          providerId: value.providerId,
          groupIds: [value.group.id],
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
      group: {
        id: assignmentQuery.data.groupId,
        label: assignmentQuery.data.groupName,
        auxiliaryData: {},
      },
      scopeKeys: assignmentQuery.data.scopes,
    });
  }, [assignmentQuery.data, form]);

  const providerId = useStore(form.store, (state) => state.values.providerId);
  const assignedGroupIdsQuery = useQuery({
    ...trpc.admin.groupAssignments.assignedGroupIds.queryOptions({ providerId }),
    enabled: isNew && Boolean(providerId),
  });
  const assignedGroupIds = useMemo(
    () => new Set(assignedGroupIdsQuery.data ?? []),
    [assignedGroupIdsQuery.data],
  );
  const groupSearchSource = useMemo<SearchSource<ProviderGroupTypeaheadItem>>(() => {
    const loadGroups = async (query: string): Promise<ProviderGroupTypeaheadItem[]> => {
      if (!providerId) return [];
      try {
        setGroupSearchError(null);
        const groups = await queryClient.fetchQuery(
          trpc.admin.groupProviders.searchGroups.queryOptions({
            providerId,
            query,
            limit: 50,
          }),
        );
        return groups.map((group) => ({
          id: group.id,
          label: group.name,
          auxiliaryData: group.description ? { description: group.description } : {},
        }));
      } catch (error) {
        setGroupSearchError(asError(error));
        throw error;
      }
    };
    return {
      search: loadGroups,
      bootstrap: () => loadGroups(""),
    };
  }, [providerId, queryClient, trpc]);

  const assignment = assignmentQuery.data;
  const title = isNew
    ? "Create group assignment"
    : assignment
      ? `Edit ${assignment.groupName}`
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

  const scopes = (scopesQuery.data ?? []).filter((scope) => !scope.isSystem);
  const loadError =
    (isNew ? (providersQuery.error ?? assignedGroupIdsQuery.error ?? groupSearchError) : null) ??
    scopesQuery.error ??
    null;
  const optionsPending =
    scopesQuery.isPending ||
    (isNew && (providersQuery.isPending || assignedGroupIdsQuery.isPending));
  const groupDisabledMessage = !providerId
    ? "Choose a provider first."
    : assignedGroupIdsQuery.isPending
      ? "Loading existing assignments."
      : assignedGroupIdsQuery.error
        ? "Existing assignments could not be loaded."
        : undefined;

  return (
    <>
      <HerocrumbsTitle title={title} />
      <HerocrumbsActions>
        <Button href="/group-assignments" label="Cancel" variant="secondary" />
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button
              form={formId}
              isDisabled={!canSubmit || optionsPending || Boolean(loadError)}
              isLoading={mutation.isPending}
              label={isNew ? "Create assignment" : "Save assignment"}
              type="submit"
              variant="primary"
            />
          )}
        </form.Subscribe>
      </HerocrumbsActions>

      <div className="skill-detail-surface">
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
                        form.setFieldValue("group", null);
                        setGroupSearchError(null);
                      }}
                      options={(providersQuery.data ?? [])
                        .filter((provider) => provider.enabled)
                        .map((provider) => ({ value: provider.id, label: provider.name }))}
                      placeholder="Choose a provider…"
                      {...fieldStatusProps(field)}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </form.Field>
                <form.Field
                  name="group"
                  validators={{
                    onChange: ({ value }) => validateProviderGroup(value, assignedGroupIds),
                    onSubmit: ({ value }) => validateProviderGroup(value, assignedGroupIds),
                  }}
                >
                  {(field) => (
                    <Typeahead
                      debounceMs={250}
                      description="Search by group name or ID."
                      {...(groupDisabledMessage ? { disabledMessage: groupDisabledMessage } : {})}
                      emptySearchResultsText="No provider groups found"
                      hasEntriesOnFocus
                      isDisabled={
                        !providerId ||
                        assignedGroupIdsQuery.isPending ||
                        Boolean(assignedGroupIdsQuery.error)
                      }
                      isRequired
                      label="Group"
                      maxMenuItems={50}
                      onChange={field.handleChange}
                      placeholder="Find a group…"
                      renderItem={(item) => (
                        <div className="admin-dropdown-option group-provider-option">
                          <span
                            className="admin-dropdown-option-title group-provider-option-title"
                            title={item.label}
                          >
                            {item.label}
                          </span>
                          <div className="group-provider-option-meta">
                            <span
                              className="admin-dropdown-option-subtitle group-provider-option-id"
                              title={item.id}
                            >
                              {item.id}
                            </span>
                            {assignedGroupIds.has(item.id) ? (
                              <span className="admin-dropdown-option-subtitle shrink-0 text-[var(--color-text-danger)]">
                                Already assigned
                              </span>
                            ) : null}
                          </div>
                          {item.auxiliaryData?.description ? (
                            <span
                              className="admin-dropdown-option-subtitle group-provider-option-description"
                              title={item.auxiliaryData.description}
                            >
                              {item.auxiliaryData.description}
                            </span>
                          ) : null}
                        </div>
                      )}
                      searchSource={groupSearchSource}
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
    </>
  );
}

function validateProviderGroup(
  value: ProviderGroupTypeaheadItem | null,
  assignedGroupIds: ReadonlySet<string>,
): string | undefined {
  if (!value) return "Choose a group.";
  return assignedGroupIds.has(value.id)
    ? `${value.label} already has an assignment. Edit the existing assignment instead.`
    : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Could not search provider groups.");
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
