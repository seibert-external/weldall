import { emailSchema, LoginError, type ProviderConfig } from "./oidc-config";
import { assertEntraIdentityClaims, isTenantBoundEntraIssuer } from "./oidc-entra";

export type VerifiedIdentity = { issuer: string; subject: string; email: string; name: string };
/** Turns validated ID token claims into an identity or throws a LoginError. */
export interface OidcIdentityVerifier {
  verifyIdentity(claims: Record<string, unknown>, config: ProviderConfig): VerifiedIdentity;
}
/** Shared subject/email validation, normalization and allowed-domain checks. */
function validatedIdentityFromClaims(
  claims: Record<string, unknown>,
  config: ProviderConfig,
): VerifiedIdentity {
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
export const standardOidcIdentityVerifier: OidcIdentityVerifier = {
  verifyIdentity(claims, config) {
    if (claims.email_verified !== true) throw new LoginError("unverified_identity");
    return validatedIdentityFromClaims(claims, config);
  },
};
export const entraOidcIdentityVerifier: OidcIdentityVerifier = {
  verifyIdentity(claims, config) {
    assertEntraIdentityClaims(claims, config);
    return validatedIdentityFromClaims(claims, config);
  },
};
/** An Entra rejection is final: it never falls back to the standard verifier. */
export function identityVerifierForIssuer(issuer: string): OidcIdentityVerifier {
  return isTenantBoundEntraIssuer(issuer)
    ? entraOidcIdentityVerifier
    : standardOidcIdentityVerifier;
}
