-- Require explicit consent for every native CLI authorization request.
UPDATE "OauthClient"
SET "skipConsent" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" = 'weldall-cli';
