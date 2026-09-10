"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnyFieldApi, FieldValidateOrFn } from "@tanstack/react-form";
import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput, type TextInputProps } from "@astryxdesign/core/TextInput";
import type { LoginProviderDto } from "@/server/admin/login-providers";
import { providerTestResult, type ActiveProviderTest } from "@/lib/login-provider-test-result";
import { setupFieldSchemas } from "@/app/setup/setup-form-schema";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";
import {
  acknowledgeAuthorityValidator,
  acknowledgeLockoutValidator,
  api,
  buildBody,
  emptyForm,
  type Draft,
  type FormValues,
  type TextFieldName,
  validateClientSecret,
  validateSortOrder,
} from "./oidc-admin-api";

export function LoginProviderDetail({ providerId }: { providerId: string | null }) {
  const isNew = providerId === null;
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
  const operationToast = useOperationToast();
  const activeTest = useRef<ActiveProviderTest | null>(null);
  const revision = useRef(0);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const providersQuery = useQuery({
    queryKey: ["admin", "login-providers"],
    queryFn: async () => (await api("admin-providers")).providers as LoginProviderDto[],
    enabled: !isNew,
  });
  const draftQuery = useQuery({
    queryKey: ["admin", "login-provider-draft"],
    queryFn: async (): Promise<{ providerId: string; callbackUrl: string }> =>
      await api("admin-draft", {}),
    enabled: isNew,
    staleTime: Infinity,
  });
  const provider = isNew
    ? null
    : (providersQuery.data?.find((p) => p.id === providerId) ?? null);
  const draft: Draft | null = isNew
    ? draftQuery.data
      ? {
          providerId: draftQuery.data.providerId,
          callbackUrl: draftQuery.data.callbackUrl,
          expectedVersion: 0,
        }
      : null
    : provider
      ? {
          providerId: provider.id,
          callbackUrl: provider.callbackUrl,
          expectedVersion: provider.version,
        }
      : null;

  const form = useForm({
    defaultValues: emptyForm,
    onSubmit: async ({ value }) => {
      if (!draft || saving || testing) return;
      setSaving(true);
      try {
        await api("admin-save", buildBody(draft, value));
        operationToast.success(
          isNew ? "Login provider created" : "Login provider saved",
          "login-provider-save",
        );
        await queryClient.invalidateQueries({ queryKey: ["admin", "login-providers"] });
        router.push("/admin/login-providers");
      } catch (error) {
        operationToast.error(
          isNew ? "Could not create provider" : "Could not save provider",
          error,
          "login-provider-save",
        );
      } finally {
        setSaving(false);
      }
    },
  });

  // Populate the form once an edited provider has loaded. The issuer is immutable and the
  // client secret is write-only, so both stay untouched after the initial load. The authority
  // acknowledgement is pre-checked for edits — re-confirming on every save adds friction for
  // cosmetic changes — while the server still requires it for enabled saves.
  useEffect(() => {
    if (isNew || !provider) return;
    form.reset({
      name: provider.name,
      buttonLabel: provider.buttonLabel,
      buttonColor: provider.buttonColor,
      sortOrder: String(provider.sortOrder),
      issuer: provider.issuer,
      discoveryUrl: provider.discoveryUrl ?? "",
      clientId: provider.clientId,
      clientSecret: "",
      tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
      scopes: provider.scopes.join(" "),
      domains: provider.allowedEmailDomains.join(", "),
      enabled: provider.enabled,
      acknowledgeAuthority: true,
      acknowledgeLockout: false,
    });
  }, [form, provider, isNew]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const passed = providerTestResult(
        event,
        activeTest.current,
        window.location.origin,
        revision.current,
      );
      if (passed === undefined) return;
      activeTest.current = null;
      if (passed) {
        operationToast.success(
          "Test login passed for these values. Save explicitly to apply them.",
          "login-provider-test",
        );
      } else {
        operationToast.error(
          "Test login failed. Check the configuration and try again.",
          new Error("test_failed"),
          "login-provider-test",
        );
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [operationToast]);

  function testLogin() {
    if (!draft || saving || testing) return;
    // Open synchronously so popup blockers do not turn an async response into a blocked window.
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      operationToast.error(
        "Allow popups for Test login, then retry.",
        new Error("popup_blocked"),
        "login-provider-test",
      );
      return;
    }
    revision.current++;
    activeTest.current = null;
    setTesting(true);
    const currentRevision = revision.current;
    const testId = crypto.randomUUID();
    activeTest.current = { popup, testId, revision: currentRevision };
    void (async () => {
      try {
        const result = await api("admin-test", {
          ...buildBody(draft, form.state.values),
          testId,
        });
        if (currentRevision !== revision.current) {
          popup.close();
          return;
        }
        popup.location.assign(result.url);
      } catch (error) {
        popup.close();
        activeTest.current = null;
        operationToast.error("Test login could not start", error, "login-provider-test");
      } finally {
        setTesting(false);
      }
    })();
  }

  function invalidate() {
    revision.current++;
    activeTest.current = null;
  }

  if (isNew && draftQuery.isPending) {
    return <Text color="secondary">Preparing new login provider…</Text>;
  }
  if (!isNew && providersQuery.isPending) {
    return <Text color="secondary">Loading login provider…</Text>;
  }
  if (isNew && draftQuery.error) {
    return (
      <>
        <Banner
          container="card"
          description={draftQuery.error.message}
          status="error"
          title="Could not prepare a new login provider"
        />
        <Button href="/admin/login-providers" label="Back to login providers" variant="secondary" />
      </>
    );
  }
  if (!isNew && providersQuery.error) {
    return (
      <Banner
        container="card"
        description={providersQuery.error.message}
        status="error"
        title="Could not load login provider"
      />
    );
  }
  if (!draft) {
    return (
      <>
        <Banner
          container="card"
          description="The provider does not exist or was removed."
          status="error"
          title="Login provider not found"
        />
        <Button href="/admin/login-providers" label="Back to login providers" variant="secondary" />
      </>
    );
  }

  const editing = Boolean(provider);
  const field = (
    name: TextFieldName,
    label: string,
    validator: FieldValidateOrFn<FormValues, TextFieldName, string>,
    options: {
      type?: TextInputProps["type"];
      optional?: boolean;
      description?: string;
      placeholder?: string;
      isDisabled?: boolean;
    } = {},
  ) => (
    <form.Field name={name} validators={{ onChange: validator, onSubmit: validator }}>
      {(fieldApi) => (
        <TextInput
          htmlName={name}
          label={label}
          type={options.type ?? "text"}
          isRequired={!options.optional}
          isOptional={Boolean(options.optional)}
          {...(options.isDisabled === undefined ? {} : { isDisabled: options.isDisabled })}
          {...(options.description ? { description: options.description } : {})}
          {...(options.placeholder ? { placeholder: options.placeholder } : {})}
          onBlur={fieldApi.handleBlur}
          onChange={(value) => {
            invalidate();
            fieldApi.handleChange(value);
          }}
          value={fieldApi.state.value}
          width="100%"
          {...fieldStatusProps(fieldApi)}
        />
      )}
    </form.Field>
  );

  return (
    <>
      <HerocrumbsActions>
        <Button
          isDisabled={saving || testing}
          label="Test login (new tab)"
          onClick={testLogin}
          type="button"
          variant="secondary"
        />
        <Button href="/admin/login-providers" label="Cancel" variant="secondary" />
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.submissionAttempts] as const}
        >
          {([canSubmit, submissionAttempts]) => {
            // Before the first submit attempt the button stays enabled so validation
            // errors can be surfaced; afterwards it reflects validity.
            const blockSubmit = submissionAttempts > 0 && !canSubmit;
            return (
              <Button
                form={formId}
                isDisabled={blockSubmit || saving || testing}
                isLoading={saving}
                label={isNew ? "Create provider" : "Save configuration"}
                type="submit"
                variant="primary"
              />
            );
          }}
        </form.Subscribe>
      </HerocrumbsActions>
      <div className="skill-detail-surface">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold">
            {isNew ? "Create login provider" : provider?.name}
          </h2>
          {provider ? (
            <Text color="secondary">
              Version {provider.version} · Validated {new Date(provider.validatedAt).toLocaleString()}
            </Text>
          ) : (
            <Text color="secondary">
              OIDC providers assert identity, not Weldall permissions. The issuer is immutable
              once set.
            </Text>
          )}
        </div>
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
            {field("name", "Internal name", setupFieldSchemas.name)}
            {field("buttonLabel", "Login button label", setupFieldSchemas.buttonLabel)}
            {field("buttonColor", "Button color", setupFieldSchemas.buttonColor, {
              placeholder: "#2563eb",
              description:
                "Six-digit hex color. Login text contrast is calculated automatically.",
            })}
            {field("sortOrder", "Order (lower first)", validateSortOrder)}
            {field(
              "issuer",
              editing ? "Exact issuer (immutable once set)" : "Exact HTTPS issuer",
              setupFieldSchemas.issuer,
              { placeholder: "https://identity.example.com", isDisabled: editing },
            )}
            {field("discoveryUrl", "Discovery URL override", setupFieldSchemas.discoveryUrl, {
              optional: true,
              description: "Leave empty to discover configuration from the issuer.",
            })}
            <div className="grid gap-2">
              <TextInput
                description="Register this exact URL with your identity provider. It stays the same after installation."
                isDisabled
                label="Callback URL"
                value={draft.callbackUrl}
                width="100%"
              />
              <Button
                label="Copy callback URL"
                onClick={() => void navigator.clipboard.writeText(draft.callbackUrl)}
                type="button"
                variant="secondary"
              />
            </div>
            {field("clientId", "Client ID", setupFieldSchemas.clientId)}
            {field(
              "clientSecret",
              editing ? "Client secret (write-only; blank keeps existing)" : "Client secret",
              ({ value }) => validateClientSecret(value, editing),
              { type: "password", optional: editing },
            )}
            <form.Field
              name="tokenEndpointAuthMethod"
              validators={{
                onChange: setupFieldSchemas.tokenEndpointAuthMethod,
                onSubmit: setupFieldSchemas.tokenEndpointAuthMethod,
              }}
            >
              {(fieldApi) => (
                <Selector
                  isRequired
                  label="Token endpoint authentication"
                  onBlur={fieldApi.handleBlur}
                  onChange={(value) => {
                    invalidate();
                    fieldApi.handleChange(
                      setupFieldSchemas.tokenEndpointAuthMethod.parse(value),
                    );
                  }}
                  options={["client_secret_basic", "client_secret_post"]}
                  value={fieldApi.state.value}
                  width="100%"
                  {...fieldStatusProps(fieldApi)}
                />
              )}
            </form.Field>
            {field("scopes", "Scopes", setupFieldSchemas.scopes, {
              description: "Space-separated scopes; openid and email are required.",
            })}
            {field(
              "domains",
              "Allowed email domains",
              setupFieldSchemas.domains,
              {
                optional: true,
                description:
                  "Comma-separated exact domains. Leave empty to trust all verified emails.",
              },
            )}
            <form.Field name="enabled">
              {(fieldApi) => (
                <Switch
                  description="Disabled providers are not offered on the login page but remain configured."
                  label="Enabled"
                  labelPosition="start"
                  labelSpacing="spread"
                  onChange={(value) => {
                    invalidate();
                    fieldApi.handleChange(value);
                  }}
                  value={fieldApi.state.value}
                  width="100%"
                />
              )}
            </form.Field>
            <form.Field
              name="acknowledgeAuthority"
              validators={{
                onChange: acknowledgeAuthorityValidator,
                onSubmit: acknowledgeAuthorityValidator,
              }}
            >
              {(fieldApi) => (
                <CheckboxInput
                  description="Verified email is the provider's assertion, not independent proof. Domain restrictions limit its authority but cannot make a malicious provider safe. Acknowledge before every enabled save."
                  isRequired
                  label="I trust this provider to assert email identities"
                  onBlur={fieldApi.handleBlur}
                  onChange={(value) => {
                    invalidate();
                    fieldApi.handleChange(value);
                  }}
                  value={fieldApi.state.value}
                  width="100%"
                  {...fieldStatusProps(fieldApi)}
                />
              )}
            </form.Field>
            <form.Subscribe selector={(state) => state.values.enabled}>
              {(enabled) => {
                const lastEnabled =
                  Boolean(provider) &&
                  (providersQuery.data ?? []).filter((p) => p.enabled).length === 1 &&
                  (providersQuery.data ?? []).some(
                    (p) => p.id === draft.providerId && p.enabled,
                  ) &&
                  !enabled;
                return lastEnabled ? (
                  <form.Field
                    name="acknowledgeLockout"
                    validators={{
                      onChange: acknowledgeLockoutValidator,
                      onSubmit: acknowledgeLockoutValidator,
                    }}
                  >
                    {(fieldApi) => (
                      <CheckboxInput
                        description="Keep an administrator session open."
                        isRequired
                        label="I understand disabling the last enabled provider may make new login impossible"
                        onBlur={fieldApi.handleBlur}
                        onChange={(value) => {
                          invalidate();
                          fieldApi.handleChange(value);
                        }}
                        value={fieldApi.state.value}
                        width="100%"
                        {...fieldStatusProps(fieldApi)}
                      />
                    )}
                  </form.Field>
                ) : null;
              }}
            </form.Subscribe>
            {testing ? (
              <Text color="secondary" role="status">
                Test login in progress in the new tab. If it closes or expires, retry Test login.
              </Text>
            ) : null}
          </FormLayout>
        </form>
      </div>
    </>
  );
}

function fieldStatusProps(field: AnyFieldApi) {
  // Show errors only once the field has been blurred or the form has been
  // submitted at least once — never while the user is still typing.
  const showErrors = field.state.meta.isBlurred || field.form.state.submissionAttempts > 0;
  if (!showErrors) return {};
  const messages = (field.state.meta.errors ?? [])
    .map((error: unknown) =>
      typeof error === "string"
        ? error
        : error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : "",
    )
    .filter(Boolean);
  return messages.length
    ? { status: { type: "error" as const, message: messages.join(", ") } }
    : {};
}
