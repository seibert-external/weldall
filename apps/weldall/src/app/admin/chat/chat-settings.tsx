"use client";

import { useEffect, useId } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";

export function ChatSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const formId = useId();
  const operationToast = useOperationToast();
  const settingsQuery = useQuery(trpc.admin.chat.get.queryOptions());
  const updateMutation = useMutation(
    trpc.admin.chat.update.mutationOptions({
      onSuccess: () => operationToast.success("Chat settings saved", "chat-settings-save"),
      onError: (error) =>
        operationToast.error("Could not save chat settings", error, "chat-settings-save"),
    }),
  );
  const form = useForm({
    defaultValues: { enabled: false, baseUrl: "", model: "", apiKey: "" },
    onSubmit: async ({ value }) => {
      if (!settingsQuery.data) return;
      const updated = await updateMutation.mutateAsync({
        enabled: value.enabled,
        baseUrl: value.baseUrl,
        model: value.model,
        ...(value.apiKey.trim() ? { apiKey: value.apiKey } : {}),
        expectedVersion: settingsQuery.data.version,
      });
      form.reset({
        enabled: updated.enabled,
        baseUrl: updated.baseUrl,
        model: updated.model,
        apiKey: "",
      });
      await queryClient.invalidateQueries();
    },
  });

  useEffect(() => {
    if (settingsQuery.data) {
      form.reset({
        enabled: settingsQuery.data.enabled,
        baseUrl: settingsQuery.data.baseUrl,
        model: settingsQuery.data.model,
        apiKey: "",
      });
    }
  }, [form, settingsQuery.data]);

  if (settingsQuery.isPending) return <Text color="secondary">Loading chat settings…</Text>;
  if (settingsQuery.error) {
    return (
      <Banner
        container="card"
        status="error"
        title="Could not load chat settings"
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
            <Text color="secondary">
              Configure the OpenAI-compatible provider used by the fullscreen chat experience. The
              API key is encrypted and write-only.
            </Text>
            <form.Field name="enabled">
              {(field) => (
                <Switch
                  description="When disabled, users see that chat is unavailable and no model requests are made."
                  label="Enabled"
                  labelPosition="start"
                  labelSpacing="spread"
                  onChange={field.handleChange}
                  value={field.state.value}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="baseUrl"
              validators={{
                onBlur: ({ value }) => validateBaseUrl(value),
                onChange: ({ value }) => validateBaseUrl(value),
                onSubmit: ({ value }) => validateBaseUrl(value),
              }}
            >
              {(field) => (
                <TextInput
                  isRequired
                  label="Provider base URL"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="https://provider.example.com/v1"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="model"
              validators={{
                onBlur: ({ value }) => validateModel(value),
                onChange: ({ value }) => validateModel(value),
                onSubmit: ({ value }) => validateModel(value),
              }}
            >
              {(field) => (
                <TextInput
                  isRequired
                  label="Model"
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder="example-model"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="apiKey"
              validators={{
                onBlur: ({ value }) => validateApiKey(value),
                onSubmit: ({ value }) => validateApiKey(value),
              }}
            >
              {(field) => (
                <TextInput
                  isOptional={settingsQuery.data?.hasApiKey}
                  isRequired={!settingsQuery.data?.hasApiKey}
                  label={settingsQuery.data?.hasApiKey ? "Replacement API key" : "API key"}
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  placeholder={
                    settingsQuery.data?.hasApiKey ? "Leave empty to keep current key" : ""
                  }
                  type="password"
                  value={String(field.state.value)}
                  width="100%"
                />
              )}
            </form.Field>
          </FormLayout>
        </form>
      </div>
    </>
  );
}

function validateBaseUrl(value: unknown): string | undefined {
  const raw = String(value).trim();
  if (!raw || raw.length > 2_000) return "Enter a base URL of at most 2,000 characters.";
  try {
    const url = new URL(raw);
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const protocolAllowed =
      url.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" && isLoopback && url.protocol === "http:");
    return protocolAllowed && !url.username && !url.password && !url.search && !url.hash
      ? undefined
      : "Use an HTTPS URL without credentials, query, or hash.";
  } catch {
    return "Enter an absolute HTTPS URL.";
  }
}

function validateModel(value: unknown): string | undefined {
  const model = String(value).trim();
  return model.length >= 1 && model.length <= 200
    ? undefined
    : "Model must contain 1 to 200 characters.";
}

function validateApiKey(value: unknown): string | undefined {
  const apiKey = String(value).trim();
  if (!apiKey) return undefined;
  if (apiKey.length > 10_000) return "API key must be 10,000 characters or less.";
  return /[\u0000-\u001f\u007f]/u.test(apiKey)
    ? "API key must not contain control characters."
    : undefined;
}
