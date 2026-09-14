import type { AnyFieldApi } from "@tanstack/react-form";
import { parseDomains, parseScopes } from "@/app/setup/setup-form-schema";

export type Draft = { providerId: string; callbackUrl: string; expectedVersion: number };

export async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/auth/oidc/${path}`, {
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", "x-weldall-csrf": "1" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(String(result.error ?? "provider_unavailable"));
  return result;
}

export const emptyForm = {
  name: "",
  buttonLabel: "Continue with SSO",
  buttonColor: "#2563eb",
  sortOrder: "0",
  issuer: "",
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  tokenEndpointAuthMethod: "client_secret_basic",
  scopes: "openid profile email",
  domains: "",
  enabled: false,
  acknowledgeAuthority: false,
  acknowledgeLockout: false,
};
export type FormValues = typeof emptyForm;
export type TextFieldName = Exclude<
  keyof FormValues,
  "enabled" | "acknowledgeAuthority" | "acknowledgeLockout"
>;

export function buildBody(draft: Draft, value: FormValues) {
  return {
    providerId: draft.providerId,
    expectedVersion: draft.expectedVersion,
    enabled: value.enabled,
    acknowledgeAuthority: value.acknowledgeAuthority,
    acknowledgeLockout: value.acknowledgeLockout,
    config: {
      name: value.name,
      buttonLabel: value.buttonLabel,
      buttonColor: value.buttonColor,
      sortOrder: Number(value.sortOrder),
      issuer: value.issuer,
      ...(value.discoveryUrl ? { discoveryUrl: value.discoveryUrl } : {}),
      clientId: value.clientId,
      ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}),
      tokenEndpointAuthMethod: value.tokenEndpointAuthMethod,
      scopes: parseScopes(value.scopes),
      allowedEmailDomains: parseDomains(value.domains),
    },
  };
}

export function validateClientSecret(value: unknown, isOptional: boolean): string | undefined {
  const secret = String(value);
  if (!secret) return isOptional ? undefined : "Client secret is required.";
  if (secret.length > 4096) return "Client secret must be 4096 characters or less.";
  return undefined;
}

export function validateSortOrder({ value }: { value: unknown }): string | undefined {
  const raw = String(value).trim();
  if (raw === "") return "Order is required.";
  const order = Number(raw);
  if (!Number.isInteger(order) || order < -10000 || order > 10000) {
    return "Order must be an integer between -10000 and 10000.";
  }
  return undefined;
}

export function acknowledgeAuthorityValidator({
  value,
  fieldApi,
}: {
  value: boolean;
  fieldApi: AnyFieldApi;
}): string | undefined {
  if (!fieldApi.form.state.values.enabled) return undefined;
  return value ? undefined : "Acknowledge that you trust this provider.";
}

export function acknowledgeLockoutValidator({
  value,
  fieldApi,
}: {
  value: boolean;
  fieldApi: AnyFieldApi;
}): string | undefined {
  const enabled = fieldApi.form.state.values.enabled;
  return value || enabled ? undefined : "Acknowledge the last-provider lockout risk.";
}
