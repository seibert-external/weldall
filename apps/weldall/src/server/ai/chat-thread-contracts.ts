import type { ChatThreadMetadataRecord } from "./chat-threads";

export function serializeChatThreadMetadata(thread: ChatThreadMetadataRecord) {
  return {
    remoteId: thread.id,
    status: thread.archivedAt ? ("archived" as const) : ("regular" as const),
    ...(thread.title ? { title: thread.title } : {}),
    lastMessageAt: thread.lastMessageAt.toISOString(),
  };
}
