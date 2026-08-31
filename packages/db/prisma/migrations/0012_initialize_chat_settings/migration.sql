INSERT INTO "ChatSettings" (
  "id", "enabled", "baseUrl", "model", "version", "createdAt", "updatedAt", "createdBy", "updatedBy"
)
VALUES (
  'default', false, 'https://provider.example.com/v1', 'example-model', 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
)
ON CONFLICT ("id") DO NOTHING;
