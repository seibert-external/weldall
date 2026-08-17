-- Use BrowserConnectionIssuanceAttempt.requestId as the single authoritative
-- request-to-attempt relation. The former scalar was not a foreign key.
DROP INDEX "BrowserConnectionRequest_issuanceAttemptId_key";
ALTER TABLE "BrowserConnectionRequest" DROP COLUMN "issuanceAttemptId";

-- A browser refresh binding must match the complete connection security identity,
-- not merely point at a connection id. Retention cleanup cascades already-revoked
-- local bindings when the retained connection is eventually deleted.
ALTER TABLE "OAuthDeviceRefreshBinding"
  DROP CONSTRAINT "OAuthDeviceRefreshBinding_browserConnectionId_fkey";
CREATE UNIQUE INDEX "BrowserConnection_binding_identity_key"
  ON "BrowserConnection"("id", "refreshFamilyId", "browserClientId", "userId", "dpopJkt");
ALTER TABLE "OAuthDeviceRefreshBinding"
  ADD CONSTRAINT "OAuthDeviceRefreshBinding_browserConnectionId_familyId_clientId_userId_dpopJkt_fkey"
  FOREIGN KEY ("browserConnectionId", "familyId", "clientId", "userId", "dpopJkt")
  REFERENCES "BrowserConnection"("id", "refreshFamilyId", "browserClientId", "userId", "dpopJkt")
  ON DELETE CASCADE ON UPDATE CASCADE;
