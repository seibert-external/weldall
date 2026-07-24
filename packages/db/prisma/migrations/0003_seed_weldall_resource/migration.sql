-- Keep the fixed Weldall API resource available before the first auth request.
-- The runtime config fills the environment-specific signing key id.
INSERT INTO "OauthResource" (
  "id",
  "identifier",
  "name",
  "signingAlgorithm",
  "allowedScopes",
  "dpopBoundAccessTokensRequired",
  "disabled",
  "policyVersion",
  "createdAt",
  "updatedAt"
) VALUES (
  'weldall-api',
  'https://weldall.seibert.localdev/api',
  'Weldall API',
  'ES256',
  ARRAY['openid', 'offline_access', 'weldall:scopes']::TEXT[],
  true,
  false,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("identifier") DO UPDATE SET
  "name" = EXCLUDED."name",
  "signingAlgorithm" = EXCLUDED."signingAlgorithm",
  "allowedScopes" = EXCLUDED."allowedScopes",
  "dpopBoundAccessTokensRequired" = EXCLUDED."dpopBoundAccessTokensRequired",
  "disabled" = false,
  "updatedAt" = CURRENT_TIMESTAMP;
