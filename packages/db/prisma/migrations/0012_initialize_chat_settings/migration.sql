INSERT INTO "ChatSettings" (
  "id", "enabled", "baseUrl", "model", "version", "createdAt", "updatedAt", "createdBy", "updatedBy"
)
VALUES (
  'default', false, 'https://vllm.seibert.tools/v1', 'deepseek-v4-flash-low', 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'migration', 'migration'
)
ON CONFLICT ("id") DO NOTHING;
