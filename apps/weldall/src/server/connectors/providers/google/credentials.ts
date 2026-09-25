import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ConnectorError } from "../../errors";
import type { ProviderGrant } from "../../provider";
import {
  canonicalScopes,
  requiredScopes,
  scopeSetSchema,
  selectionSchema,
  validateSelectedScopes,
} from "./setup";
import { parseGoogleConfiguration } from "./config";
import { credentialsSchema } from "./oauth";

const grantSchema = z.object({ scopes: scopeSetSchema }).strict();
export type GoogleGrant = ProviderGrant<{ scopes: readonly string[] }>;
/** Creates a grant brand only after validating its stored shape and required protocol scopes. */
export function parseGoogleGrant(value: unknown): GoogleGrant {
  const grant = grantSchema.parse(value);
  if (requiredScopes.some((scope) => !grant.scopes.includes(scope)))
    throw new ConnectorError("grant_mismatch", "Provider grant differs from the request.");
  return Object.freeze({ scopes: Object.freeze(grant.scopes) }) as GoogleGrant;
}
/** Reconciles persisted consent, token scopes, and grant without alias or implication mappings. */
export function validateGoogleGrant({
  config,
  selection,
  credentials,
  grant,
}: {
  config: unknown;
  selection: unknown;
  credentials: unknown;
  grant: unknown;
}): GoogleGrant {
  const requested = validateSelectedScopes({
    config: parseGoogleConfiguration(config),
    selected: selectionSchema.parse(selection).scopes,
  });
  const parsed = parseGoogleGrant(grant);
  const tokenScopes = canonicalScopes(credentialsSchema.parse(credentials).grantedScopes);
  if (!isDeepStrictEqual(requested, parsed.scopes) || !isDeepStrictEqual(requested, tokenScopes))
    throw new ConnectorError("grant_mismatch", "Provider grant differs from the request.");
  return parsed;
}
