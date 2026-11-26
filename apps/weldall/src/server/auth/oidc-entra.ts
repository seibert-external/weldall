import { LoginError, type ProviderConfig } from "./oidc-config";

const ENTRA_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/;
/** Tenant GUID of a tenant-bound Entra ID v2.0 issuer; multi-tenant and v1 issuers are generic OIDC. */
function entraTenant(issuer: string): string | undefined {
  return ENTRA_ISSUER.exec(issuer)?.[1];
}
export function isTenantBoundEntraIssuer(issuer: string): boolean {
  return entraTenant(issuer) !== undefined;
}
// Weldall links accounts by email, so an unverified email would allow account takeover ("nOAuth").
// Entra never sends email_verified; it marks verified emails with xms_edov instead (claims xms_edov,
// acct, idp: https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).
// xms_edov is a JSON boolean and only true is accepted. xms_edov can be true for guests whose email
// is a Microsoft account, Google or one-time passcode, so the guest check is the actual barrier:
// acct must be exactly 0 (a missing acct is a configuration error, not proof of membership) and
// idp, if present, must name this tenant.
export function assertEntraIdentityClaims(claims: Record<string, unknown>, config: ProviderConfig) {
  const tenant = entraTenant(config.issuer);
  if (!tenant || claims.tid !== tenant) throw new LoginError("unverified_identity");
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
