"use client";

import { useEffect, useId } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";

export function CliSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const formId = useId();
  const settingsQuery = useQuery(trpc.admin.cli.get.queryOptions());
  const updateMutation = useMutation(trpc.admin.cli.update.mutationOptions());
  const form = useForm({
    defaultValues: { appendix: "" },
    onSubmit: async ({ value }) => {
      if (!settingsQuery.data) return;
      const updated = await updateMutation.mutateAsync({
        appendix: value.appendix,
        expectedVersion: settingsQuery.data.version,
      });
      form.reset({ appendix: updated.appendix });
      await queryClient.invalidateQueries();
    },
  });

  useEffect(() => {
    if (settingsQuery.data) form.reset({ appendix: settingsQuery.data.appendix });
  }, [form, settingsQuery.data]);

  if (settingsQuery.isPending) return <Text color="secondary">Loading CLI settings…</Text>;
  if (settingsQuery.error) {
    return (
      <Banner
        container="card"
        status="error"
        title="Could not load CLI settings"
        description={settingsQuery.error.message}
      />
    );
  }

  return (
    <>
      <HerocrumbsActions>
        <form.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button
              form={formId}
              isDisabled={!canSubmit}
              isLoading={updateMutation.isPending}
              label="Save"
              type="submit"
              variant="primary"
            />
          )}
        </form.Subscribe>
      </HerocrumbsActions>

      <div className="skill-detail-surface">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold">CLI instructions</h2>
          <Text color="secondary">
            Shared Markdown for general organization-specific CLI guidance.
          </Text>
        </div>

        {updateMutation.error ? (
          <Banner
            container="card"
            status="error"
            title="Could not save CLI settings"
            description={updateMutation.error.message}
          />
        ) : updateMutation.isSuccess ? (
          <Banner container="card" status="success" title="CLI settings saved" />
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
              name="appendix"
              validators={{
                onChange: ({ value }) =>
                  value.length <= 100_000
                    ? undefined
                    : "CLI appendix must be 100,000 characters or less.",
                onSubmit: ({ value }) =>
                  value.length <= 100_000
                    ? undefined
                    : "CLI appendix must be 100,000 characters or less.",
              }}
            >
              {(field) => (
                <TextArea
                  label="CLI appendix"
                  maxLength={100_000}
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="Gude! Dieses Tool kannst du für alles nutzen, was mit Seibert zusammenhängt."
                  rows={24}
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
