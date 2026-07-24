-- Let the native CLI request the standard OIDC claims used by `weldall status`.
UPDATE "OauthClient"
SET
  "scopes" = ARRAY['openid', 'profile', 'email', 'offline_access', 'weldall:scopes']::TEXT[],
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" = 'weldall-cli';

UPDATE "OauthResource"
SET
  "allowedScopes" = ARRAY['openid', 'profile', 'email', 'offline_access', 'weldall:scopes']::TEXT[],
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "identifier" = 'https://weldall.seibert.localdev/api';
