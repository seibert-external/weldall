import { z } from "zod";
import { emailSchema, providerConfigSchema } from "@/server/auth/oidc-config";

const provider = providerConfigSchema.shape;
export const parseScopes = (value: string) => value.trim().split(/\s+/).filter(Boolean);
export const parseDomains = (value: string) => value.split(/[\s,]+/).filter(Boolean);

export const setupFormDefaults = {
  token: "",
  adminEmail: "",
  name: "",
  buttonLabel: "Continue with SSO",
  buttonColor: "#2563eb",
  issuer: "",
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  tokenEndpointAuthMethod: "client_secret_basic" as "client_secret_basic" | "client_secret_post",
  scopes: "openid profile email",
  domains: "",
  acknowledgeAuthority: false,
};

export const setupFormSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/, "Enter the operator's base64url setup token."),
  adminEmail: emailSchema,
  name: provider.name,
  buttonLabel: provider.buttonLabel,
  buttonColor: provider.buttonColor,
  issuer: provider.issuer,
  discoveryUrl: z.union([z.literal(""), provider.discoveryUrl.unwrap()]),
  clientId: provider.clientId,
  clientSecret: provider.clientSecret,
  tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
  scopes: z.string().refine((value) => provider.scopes.safeParse(parseScopes(value)).success, {
    message: "Include openid and email, with no duplicate scopes or offline_access (maximum 20).",
  }),
  domains: z
    .string()
    .refine((value) => provider.allowedEmailDomains.safeParse(parseDomains(value)).success, {
      message:
        "Enter exact email domains separated by commas; wildcards are not allowed (maximum 100).",
    }),
  acknowledgeAuthority: z
    .boolean()
    .refine((value) => value, "Acknowledge that you trust this provider."),
});

/**
 * Per-field schemas for TanStack Form field-level validators.
 *
 * Each field validates only its own value on change (instead of re-running the
 * whole form schema on every keystroke), while the form-level `onSubmit`
 * validator still checks the full contract when installation is attempted.
 */
export const setupFieldSchemas = setupFormSchema.shape;
