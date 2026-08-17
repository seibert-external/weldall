ALTER TABLE "OAuthDeviceRefreshBinding"
  ADD CONSTRAINT "OAuthDeviceRefreshBinding_browser_connection_required" CHECK (
    "clientId" NOT LIKE 'weldall-browser:%' OR "browserConnectionId" IS NOT NULL
  );

ALTER TABLE "BrowserConnectionRequest"
  ADD CONSTRAINT "BrowserConnectionRequest_device_hash" CHECK (
    "deviceCodeHash" ~ '^[A-Za-z0-9_-]{43}$'
  ),
  ADD CONSTRAINT "BrowserConnectionRequest_user_hash" CHECK (
    "userCodeHash" ~ '^[A-Za-z0-9_-]{43}$'
  ),
  ADD CONSTRAINT "BrowserConnectionRequest_jkt" CHECK (
    "dpopJkt" ~ '^[A-Za-z0-9_-]{43}$'
  ),
  ADD CONSTRAINT "BrowserConnectionRequest_poll_interval" CHECK (
    "pollIntervalSeconds" >= 5 AND "pollIntervalSeconds" <= 300
  ),
  ADD CONSTRAINT "BrowserConnectionRequest_attempts" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "BrowserConnectionRequest_terminal_state" CHECK (
    ("status" = 'APPROVED' AND "approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL)
    OR ("status" = 'DENIED' AND "deniedAt" IS NOT NULL)
    OR ("status" = 'CONSUMED' AND "consumedAt" IS NOT NULL AND "connectionId" IS NOT NULL)
    OR "status" IN ('PENDING', 'EXPIRED', 'ISSUING')
  );

ALTER TABLE "BrowserConnection"
  ADD CONSTRAINT "BrowserConnection_jkt" CHECK (
    "dpopJkt" ~ '^[A-Za-z0-9_-]{43}$'
  ),
  ADD CONSTRAINT "BrowserConnection_state_timestamps" CHECK (
    ("state" = 'ACTIVE' AND "revokedAt" IS NULL)
    OR ("state" = 'REVOKED' AND "revokedAt" IS NOT NULL AND "revocationReason" IS NOT NULL)
  );

ALTER TABLE "BrowserConnectionRateLimitBucket"
  ADD CONSTRAINT "BrowserConnectionRateLimitBucket_count" CHECK ("count" > 0),
  ADD CONSTRAINT "BrowserConnectionRateLimitBucket_window" CHECK ("expiresAt" > "windowStart");
