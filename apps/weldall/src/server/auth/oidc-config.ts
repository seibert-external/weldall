import { z } from "zod";

export class LoginError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const emailSchema = z.string().trim().toLowerCase().email().max(320);
export function httpsUrl(value: string): string {
  const url = new URL(value);
  if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new LoginError("invalid_url");
  return value;
}
export const httpsUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      httpsUrl(value);
      return true;
    } catch {
      return false;
    }
  });
export const oidcScopeSchema = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/);
export const oidcScopesSchema = z
  .array(oidcScopeSchema)
  .min(2)
  .max(20)
  .default(["openid", "profile", "email"])
  .refine(
    (scopes) =>
      scopes.includes("openid") &&
      scopes.includes("email") &&
      !scopes.includes("offline_access") &&
      new Set(scopes).size === scopes.length,
  );
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
export const providerConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    buttonLabel: z.string().trim().min(1).max(80),
    buttonColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    sortOrder: z.number().int().min(-10000).max(10000).default(0),
    issuer: httpsUrlSchema.refine((value) => {
      try {
        return !new URL(value).search;
      } catch {
        return false;
      }
    }),
    discoveryUrl: httpsUrlSchema.optional(),
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]),
    scopes: oidcScopesSchema,
    allowedEmailDomains: z.array(domainSchema).max(100).default([]),
  })
  .strict();
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export function discoveryUrl(config: ProviderConfig): string {
  return (
    config.discoveryUrl ?? `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
  );
}
export function buttonForeground(color: string): string {
  const channels = [1, 3, 5]
    .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722 > 0.179
    ? "#000000"
    : "#ffffff";
}

const ENTRA_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/;
/** Tenant GUID of a tenant-bound Entra ID v2.0 issuer; multi-tenant and v1 issuers are generic OIDC. */
export function entraTenant(issuer: string): string | undefined {
  return ENTRA_ISSUER.exec(issuer)?.[1];
}
// Weldall links accounts by email, so an unverified email would allow account takeover ("nOAuth").
// Entra never sends email_verified; it marks verified emails with xms_edov instead (claims xms_edov,
// acct, idp: https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).
// Only boolean true is accepted until a real tenant confirms the claim's JSON type. xms_edov can be
// true for guests whose email is a Microsoft account, Google or one-time passcode, so the guest
// check is the actual barrier: acct must be exactly 0 (a missing acct is a configuration error, not
// proof of membership) and idp, if present, must name this tenant.
function assertTrustedEmail(claims: Record<string, unknown>, config: ProviderConfig) {
  const tenant = entraTenant(config.issuer);
  if (!tenant) {
    if (claims.email_verified !== true) throw new LoginError("unverified_identity");
    return;
  }
  if (claims.tid !== tenant) throw new LoginError("unverified_identity");
  if (claims.acct === undefined) throw new LoginError("entra_claims_missing");
  if (
    claims.acct !== 0 ||
    (claims.idp !== undefined &&
      claims.idp !== config.issuer &&
      claims.idp !== `https://sts.windows.net/${tenant}/`)
  )
    throw new LoginError("entra_guest_denied");
  if (claims.xms_edov !== true) throw new LoginError("entra_email_unverified");
}
export function verifiedIdentity(claims: Record<string, unknown>, config: ProviderConfig) {
  assertTrustedEmail(claims, config);
  const email = emailSchema.safeParse(claims.email);
  if (
    !email.success ||
    typeof claims.sub !== "string" ||
    !claims.sub.trim() ||
    claims.sub.length > 255
  )
    throw new LoginError("unverified_identity");
  if (
    config.allowedEmailDomains.length &&
    !config.allowedEmailDomains.includes(email.data.split("@")[1]!)
  )
    throw new LoginError("email_domain_denied");
  return {
    issuer: config.issuer,
    subject: claims.sub,
    email: email.data,
    name:
      typeof claims.name === "string" && claims.name.trim()
        ? claims.name.slice(0, 200)
        : email.data,
  };
}
export type VerifiedIdentity = ReturnType<typeof verifiedIdentity>;
