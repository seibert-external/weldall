"use client";

import { useEffect, useRef, useState } from "react";
import { useForm, type AnyFieldApi } from "@tanstack/react-form";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput, type TextInputProps } from "@astryxdesign/core/TextInput";
import {
  parseDomains,
  parseScopes,
  setupFieldSchemas,
  setupFormDefaults,
  setupFormSchema,
} from "./setup-form-schema";
import { providerTestResult, type ActiveProviderTest } from "@/lib/login-provider-test-result";

type TextFieldName = Exclude<
  keyof typeof setupFormDefaults,
  "acknowledgeAuthority" | "tokenEndpointAuthMethod"
>;

export function SetupForm({ callbackUrl }: { callbackUrl: string }) {
  const activeTest = useRef<ActiveProviderTest | null>(null);
  const submission = useRef<{ testing: boolean; test: ActiveProviderTest | null }>({
    testing: false,
    test: null,
  });
  const revision = useRef(0);
  const [status, setStatus] = useState("");
  function invalidate() {
    revision.current++;
    activeTest.current = null;
    setStatus("");
  }
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const form = useForm({
    defaultValues: setupFormDefaults,
    validators: {
      // Field-level onChange validators keep per-field live feedback (feeding
      // `canSubmit`) without re-running the whole schema on every keystroke;
      // the full contract is enforced here on submit.
      onSubmit: setupFormSchema,
    },
    onSubmit: async ({ value }) => {
      if (redirecting) return;
      setError("");
      const { testing, test } = submission.current;
      if (testing && (!test || activeTest.current !== test)) {
        test?.popup.close();
        return;
      }
      const { token, adminEmail, acknowledgeAuthority, scopes, domains, discoveryUrl, ...config } =
        setupFormSchema.parse(value);
      try {
        const response = await fetch("/api/auth/oidc/setup", {
          method: "POST",
          headers: { "content-type": "application/json", "x-weldall-csrf": "1" },
          body: JSON.stringify({
            token,
            ...(test ? { mode: "setup-test", testId: test.testId } : { mode: "setup" }),
            adminEmail,
            acknowledgeAuthority,
            config: {
              ...config,
              ...(discoveryUrl ? { discoveryUrl } : {}),
              scopes: parseScopes(scopes),
              allowedEmailDomains: parseDomains(domains),
            },
          }),
        });
        const result = await response.json();
        if (!response.ok || typeof result.url !== "string") {
          if (result.error === "setup_unavailable") {
            setError(
              "Setup requires server configuration. Ask the operator to check WELDALL_SETUP_TOKEN and WELDALL_CREDENTIAL_ENCRYPTION_KEY, then reload this page.",
            );
          } else if (result.error === "setup_unauthorized") {
            setError(
              "The setup token does not match. Enter the token configured by the operator and retry.",
            );
          } else if (result.error === "setup_failed") {
            setError(
              "Setup failed internally. Retry, then ask the operator to inspect server logs.",
            );
          } else {
            setError(
              `Setup could not start (${String(result.error ?? "unavailable")}). Check the provider configuration and retry.`,
            );
          }
          test?.popup.close();
          activeTest.current = null;
          return;
        }
        if (test) {
          if (activeTest.current !== test) {
            test.popup.close();
            return;
          }
          test.popup.location.assign(result.url);
          setStatus(
            "Optional test in progress in the new tab. If it closes or expires, retry Test login.",
          );
        } else {
          setRedirecting(true);
          window.location.assign(result.url);
        }
      } catch {
        test?.popup.close();
        activeTest.current = null;
        setRedirecting(false);
        setError("Setup is unavailable. Check the configuration and retry.");
      }
      // Configuration, including secrets, stays only in this form's memory for optional testing.
    },
  });

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const passed = providerTestResult(
        event,
        activeTest.current,
        window.location.origin,
        revision.current,
        "weldall-setup-test",
      );
      if (passed === undefined) return;
      activeTest.current = null;
      setStatus(
        passed
          ? "Test login passed for these values. Nothing was saved. Complete installation requires a separate verified login."
          : "Test login failed or did not match the nominated email. You can retry or complete installation with a new verified login.",
      );
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  function submit(testing: boolean) {
    if (form.state.isSubmitting || redirecting) return;
    invalidate();
    setError("");
    if (testing && setupFormSchema.safeParse(form.state.values).success) {
      // Open in the click handler, before asynchronous validation/network work.
      const popup = window.open("about:blank", "_blank");
      if (!popup) {
        setError("Allow popups for Test login, then retry.");
        return;
      }
      activeTest.current = { popup, testId: crypto.randomUUID(), revision: revision.current };
    }
    submission.current = { testing, test: activeTest.current };
    void form.handleSubmit();
  }

  const textField = (
    name: TextFieldName,
    label: string,
    options: {
      type?: TextInputProps["type"];
      optional?: boolean;
      description?: string;
      placeholder?: string;
    } = {},
  ) => (
    <form.Field name={name} validators={{ onChange: setupFieldSchemas[name] }}>
      {(field) => (
        <TextInput
          htmlName={name}
          label={label}
          type={options.type ?? "text"}
          isRequired={!options.optional}
          isOptional={Boolean(options.optional)}
          {...(options.description ? { description: options.description } : {})}
          {...(options.placeholder ? { placeholder: options.placeholder } : {})}
          onBlur={field.handleBlur}
          onChange={(value) => {
            invalidate();
            field.handleChange(value);
          }}
          value={field.state.value}
          width="100%"
          {...fieldStatusProps(field)}
        />
      )}
    </form.Field>
  );

  return (
    <form
      autoComplete="off"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        submit(false);
      }}
    >
      <form.Subscribe
        selector={(state) =>
          [state.canSubmit, state.isSubmitting, state.submissionAttempts] as const
        }
      >
        {([canSubmit, isSubmitting, submissionAttempts]) => {
          // Before the first submit attempt the buttons stay enabled so users can
          // always surface validation errors; afterwards they reflect validity.
          const blockSubmit = submissionAttempts > 0 && !canSubmit;
          return (
            <fieldset disabled={isSubmitting || redirecting} className="m-0 min-w-0 border-0 p-0">
              <FormLayout>
                {error ? (
                  <Banner
                    container="card"
                    status="error"
                    title="Setup could not continue"
                    description={error}
                  />
                ) : null}
                {status ? <p role="status">{status}</p> : null}
                {textField("token", "Operator setup token", { type: "password" })}
                {textField("adminEmail", "First administrator email", { type: "email" })}
                {textField("name", "Provider name")}
                {textField("buttonLabel", "Login button label")}
                {textField("buttonColor", "Button color", {
                  placeholder: "#2563eb",
                  description:
                    "Six-digit hex color. Login text contrast is calculated automatically.",
                })}
                {textField("issuer", "Exact HTTPS issuer", {
                  placeholder: "https://identity.example.com",
                })}
                {textField("discoveryUrl", "Discovery URL override", {
                  optional: true,
                  description: "Leave empty to discover configuration from the issuer.",
                })}
                <TextInput
                  label="Callback URL"
                  description="Register this exact URL with your identity provider. It stays the same across reloads and after installation."
                  value={callbackUrl}
                  isDisabled
                  width="100%"
                />
                <Button
                  type="button"
                  variant="secondary"
                  label={copied ? "Callback URL copied" : "Copy callback URL"}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(callbackUrl);
                      setCopied(true);
                    } catch {
                      setError(
                        "Could not copy the callback URL. Check clipboard permissions and retry.",
                      );
                    }
                  }}
                />
                {textField("clientId", "Client ID")}
                {textField("clientSecret", "Client secret", { type: "password" })}
                <form.Field
                  name="tokenEndpointAuthMethod"
                  validators={{ onChange: setupFieldSchemas.tokenEndpointAuthMethod }}
                >
                  {(field) => (
                    <Selector
                      label="Token endpoint authentication"
                      isRequired
                      options={["client_secret_basic", "client_secret_post"]}
                      value={field.state.value}
                      onChange={(value) => {
                        invalidate();
                        field.handleChange(
                          setupFormSchema.shape.tokenEndpointAuthMethod.parse(value),
                        );
                      }}
                      onBlur={field.handleBlur}
                      width="100%"
                      {...fieldStatusProps(field)}
                    />
                  )}
                </form.Field>
                {textField("scopes", "Scopes", {
                  description: "Space-separated scopes; openid and email are required.",
                })}
                {textField("domains", "Allowed email domains", {
                  optional: true,
                  description:
                    "Comma-separated exact domains. Leave empty to trust all verified emails.",
                })}
                <form.Field
                  name="acknowledgeAuthority"
                  validators={{ onChange: setupFieldSchemas.acknowledgeAuthority }}
                >
                  {(field) => (
                    <CheckboxInput
                      label="I trust this provider to assert email identities"
                      description="Verified email is the provider's assertion, not independent proof. Domain restrictions limit its authority but cannot make a malicious provider safe."
                      isRequired
                      value={field.state.value}
                      onChange={(value) => {
                        invalidate();
                        field.handleChange(value);
                      }}
                      onBlur={field.handleBlur}
                      width="100%"
                      {...fieldStatusProps(field)}
                    />
                  )}
                </form.Field>
                <p>
                  Test login opens a new tab where it starts a login attempt. If successful you
                  might proceed.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  label="Test login (optional)"
                  isDisabled={blockSubmit || isSubmitting || redirecting}
                  onClick={() => submit(true)}
                />
                <Button
                  type="submit"
                  variant="primary"
                  label="Complete installation"
                  isDisabled={blockSubmit || redirecting}
                  isLoading={isSubmitting || redirecting}
                />
              </FormLayout>
            </fieldset>
          );
        }}
      </form.Subscribe>
    </form>
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
