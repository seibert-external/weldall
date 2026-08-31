ALTER TABLE "ChatThread"
  ADD COLUMN "headMessageId" TEXT;

ALTER TABLE "ChatThread"
  ADD CONSTRAINT "ChatThread_head_message_id_length"
    CHECK ("headMessageId" IS NULL OR char_length("headMessageId") BETWEEN 1 AND 128);

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_parent_fkey"
    FOREIGN KEY ("threadId", "parentId")
    REFERENCES "ChatMessage"("threadId", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON COLUMN "ChatThread"."headMessageId" IS
  'Canonical active message head; ownership and same-thread membership are enforced by the chat thread service.';
