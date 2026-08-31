CREATE TABLE "ChatThread" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT,
  "archivedAt" TIMESTAMP(3),
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "parentId" TEXT,
  "role" TEXT NOT NULL,
  "parts" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("threadId", "id")
);

CREATE INDEX "ChatThread_userId_lastMessageAt_id_idx"
  ON "ChatThread"("userId", "lastMessageAt" DESC, "id" DESC);
CREATE INDEX "ChatMessage_threadId_createdAt_idx"
  ON "ChatMessage"("threadId", "createdAt");

ALTER TABLE "ChatThread"
  ADD CONSTRAINT "ChatThread_title_length"
    CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 200),
  ADD CONSTRAINT "ChatThread_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_role" CHECK ("role" IN ('user', 'assistant')),
  ADD CONSTRAINT "ChatMessage_parts_array" CHECK (jsonb_typeof("parts") = 'array'),
  ADD CONSTRAINT "ChatMessage_parent_not_self" CHECK ("parentId" IS NULL OR "parentId" <> "id"),
  ADD CONSTRAINT "ChatMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
