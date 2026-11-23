-- Users could set their own profile image URL through /update-user, which is now turned off.
-- Such a URL stays fetchable through the avatar route until something overwrites it, so clear
-- every image; the group provider caches avatars again on the next membership lookup.
UPDATE "User" SET "image" = NULL WHERE "image" IS NOT NULL;

-- Closing registration does not invalidate redirect URIs registered before the upgrade.
-- Self-service clients have an owner; the seeded CLI has none, and machine clients live separately.
UPDATE "OauthClient" SET "disabled" = TRUE, "updatedAt" = NOW()
WHERE "userId" IS NOT NULL AND NOT "disabled";
