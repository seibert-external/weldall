import { db, Prisma } from "@weldall/db";
import type { UIMessage } from "ai";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 50;
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGES_PER_THREAD = 100;
const MAX_ID_LENGTH = 128;
const MIN_CURSOR_YEAR = 1;
const MAX_CURSOR_YEAR = 9_999;

export class ChatThreadNotFoundError extends Error {
  constructor() {
    super("Chat thread not found.");
  }
}

export class ChatThreadCursorError extends Error {
  constructor() {
    super("Invalid pagination cursor.");
  }
}

export class ChatThreadValidationError extends Error {}

export class ChatMessageValidationError extends Error {}

export class ChatMessageLimitError extends Error {
  constructor() {
    super(`A chat thread can contain at most ${MAX_MESSAGES_PER_THREAD} messages.`);
  }
}

type Cursor = { lastMessageAt: string; id: string };

export type ChatThreadMetadataRecord = {
  id: string;
  title: string | null;
  archivedAt: Date | null;
  headMessageId: string | null;
  lastMessageAt: Date;
};

export type StoredChatMessage = {
  id: string;
  parentId: string | null;
  role: string;
  parts: Prisma.JsonValue;
  createdAt: Date;
};

export function encodeChatThreadCursor(thread: { lastMessageAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      lastMessageAt: thread.lastMessageAt.toISOString(),
      id: thread.id,
    } satisfies Cursor),
  ).toString("base64url");
}

function decodeChatThreadCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("lastMessageAt" in parsed) ||
      !("id" in parsed) ||
      typeof parsed.lastMessageAt !== "string" ||
      typeof parsed.id !== "string" ||
      parsed.id.length < 1 ||
      parsed.id.length > MAX_ID_LENGTH
    ) {
      return undefined;
    }
    const date = new Date(parsed.lastMessageAt);
    const year = date.getUTCFullYear();
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString() !== parsed.lastMessageAt ||
      year < MIN_CURSOR_YEAR ||
      year > MAX_CURSOR_YEAR
    ) {
      return undefined;
    }
    return { lastMessageAt: parsed.lastMessageAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

export async function listChatThreads(
  userId: string,
  options: { after?: string; includeArchived?: boolean; limit?: number } = {},
): Promise<{ threads: ChatThreadMetadataRecord[]; nextCursor?: string }> {
  const cursor = decodeChatThreadCursor(options.after);
  if (options.after && !cursor) throw new ChatThreadCursorError();
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE));
  const cursorDate = cursor ? new Date(cursor.lastMessageAt) : undefined;
  const threads = await db.chatThread.findMany({
    where: {
      userId,
      ...(!options.includeArchived ? { archivedAt: null } : {}),
      ...(cursor && cursorDate
        ? {
            OR: [
              { lastMessageAt: { lt: cursorDate } },
              { lastMessageAt: cursorDate, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      title: true,
      archivedAt: true,
      headMessageId: true,
      lastMessageAt: true,
    },
  });
  const page = threads.slice(0, limit);
  return {
    threads: page,
    ...(threads.length > limit && page.at(-1)
      ? { nextCursor: encodeChatThreadCursor(page.at(-1)!) }
      : {}),
  };
}

export async function createChatThread(userId: string): Promise<ChatThreadMetadataRecord> {
  return db.chatThread.create({
    data: { userId },
    select: {
      id: true,
      title: true,
      archivedAt: true,
      headMessageId: true,
      lastMessageAt: true,
    },
  });
}

export async function getChatThread(
  userId: string,
  threadId: string,
): Promise<
  | (ChatThreadMetadataRecord & {
      messages: StoredChatMessage[];
    })
  | null
> {
  const thread = await db.chatThread.findFirst({
    where: { id: threadId, userId },
    select: {
      id: true,
      title: true,
      archivedAt: true,
      headMessageId: true,
      lastMessageAt: true,
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, parentId: true, role: true, parts: true, createdAt: true },
      },
    },
  });
  if (!thread) return null;
  return { ...thread, messages: topologicallyOrderMessages(thread.messages) };
}

export async function getChatThreadMetadata(
  userId: string,
  threadId: string,
): Promise<ChatThreadMetadataRecord | null> {
  return db.chatThread.findFirst({
    where: { id: threadId, userId },
    select: {
      id: true,
      title: true,
      archivedAt: true,
      headMessageId: true,
      lastMessageAt: true,
    },
  });
}

export async function isActiveChatThreadOwner(userId: string, threadId: string): Promise<boolean> {
  return (await db.chatThread.count({ where: { id: threadId, userId, archivedAt: null } })) === 1;
}

export async function renameChatThread(
  userId: string,
  threadId: string,
  title: string,
): Promise<boolean> {
  const normalized = normalizeTitle(title);
  const result = await db.chatThread.updateMany({
    where: { id: threadId, userId },
    data: { title: normalized },
  });
  return result.count === 1;
}

export async function setChatThreadArchived(
  userId: string,
  threadId: string,
  archived: boolean,
): Promise<boolean> {
  const result = await db.chatThread.updateMany({
    where: { id: threadId, userId },
    data: { archivedAt: archived ? new Date() : null },
  });
  return result.count === 1;
}

export async function deleteChatThread(userId: string, threadId: string): Promise<boolean> {
  const result = await db.chatThread.deleteMany({ where: { id: threadId, userId } });
  return result.count === 1;
}

export async function setChatThreadHead(
  userId: string,
  threadId: string,
  headMessageId: string | null,
): Promise<boolean> {
  if (headMessageId !== null) validateMessageId(headMessageId);
  return db.$transaction(async (tx) => {
    const thread = await lockOwnedChatThread(tx, userId, threadId);
    if (!thread) return false;
    if (headMessageId !== null) {
      const head = await tx.chatMessage.count({ where: { threadId, id: headMessageId } });
      if (head !== 1) {
        throw new ChatMessageValidationError("The selected message head was not found.");
      }
    }
    await tx.chatThread.updateMany({
      where: { id: threadId, userId },
      data: { headMessageId },
    });
    return true;
  });
}

export async function upsertChatMessage(
  userId: string,
  threadId: string,
  message: UIMessage,
  parentId: string | null,
): Promise<void> {
  validateMessageId(message.id);
  if (parentId !== null) validateMessageId(parentId);
  if (parentId === message.id) {
    throw new ChatMessageValidationError("A message cannot be its own parent.");
  }
  if (message.role !== "user" && message.role !== "assistant") {
    throw new ChatMessageValidationError("Invalid message role.");
  }

  await db.$transaction(async (tx) => {
    const thread = await lockOwnedChatThread(tx, userId, threadId);
    if (!thread) throw new ChatThreadNotFoundError();
    const existing = await tx.chatMessage.findUnique({
      where: { threadId_id: { threadId, id: message.id } },
      select: { parentId: true },
    });
    if (!existing) {
      const messageCount = await tx.chatMessage.count({ where: { threadId } });
      if (messageCount >= MAX_MESSAGES_PER_THREAD) throw new ChatMessageLimitError();
    }
    if (parentId) {
      const parent = await tx.chatMessage.count({ where: { threadId, id: parentId } });
      if (parent !== 1) {
        throw new ChatMessageValidationError("Message parent was not found.");
      }
    }
    if (existing && existing.parentId !== parentId) {
      throw new ChatMessageValidationError("Message parent cannot be changed.");
    }
    await tx.chatMessage.upsert({
      where: { threadId_id: { threadId, id: message.id } },
      create: {
        id: message.id,
        threadId,
        parentId,
        role: message.role,
        parts: message.parts as Prisma.InputJsonValue,
      },
      update: {
        parentId,
        role: message.role,
        parts: message.parts as Prisma.InputJsonValue,
      },
    });
    await tx.chatThread.updateMany({
      where: { id: threadId, userId },
      data: { headMessageId: message.id, lastMessageAt: new Date() },
    });
  });
}

export async function deleteChatMessages(
  userId: string,
  threadId: string,
  messageIds: readonly string[],
): Promise<void> {
  for (const messageId of messageIds) validateMessageId(messageId);
  await db.$transaction(async (tx) => {
    const thread = await lockOwnedChatThread(tx, userId, threadId);
    if (!thread) throw new ChatThreadNotFoundError();
    const messages = await tx.chatMessage.findMany({
      where: { threadId },
      select: { id: true, parentId: true },
    });
    const byId = new Map(messages.map((message) => [message.id, message]));
    const deleted = new Set(messageIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const message of messages) {
        if (message.parentId && deleted.has(message.parentId) && !deleted.has(message.id)) {
          deleted.add(message.id);
          changed = true;
        }
      }
    }
    let nextHead = thread.headMessageId;
    while (nextHead && deleted.has(nextHead)) {
      nextHead = byId.get(nextHead)?.parentId ?? null;
    }
    await tx.chatMessage.deleteMany({ where: { threadId, id: { in: [...deleted] } } });
    await tx.chatThread.updateMany({
      where: { id: threadId, userId },
      data: { headMessageId: nextHead },
    });
  });
}

export async function generateChatThreadTitle(
  userId: string,
  threadId: string,
  sourceText?: string,
): Promise<string> {
  const thread = await getChatThread(userId, threadId);
  if (!thread) throw new ChatThreadNotFoundError();
  const storedText = thread.messages.find((message) => message.role === "user")?.parts;
  const title = titleFromText(sourceText ?? firstTextPart(storedText) ?? "New chat");
  const updated = await renameChatThread(userId, threadId, title);
  if (!updated) throw new ChatThreadNotFoundError();
  return title;
}

function normalizeTitle(title: string): string {
  const normalized = title.replaceAll(/\s+/g, " ").trim();
  if (!normalized || normalized.length > MAX_TITLE_LENGTH) {
    throw new ChatThreadValidationError(`Title must contain 1 to ${MAX_TITLE_LENGTH} characters.`);
  }
  return normalized;
}

function titleFromText(text: string): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim() || "New chat";
  if (normalized.length <= 60) return normalizeTitle(normalized);
  return normalizeTitle(`${normalized.slice(0, 59).trimEnd()}…`);
}

async function lockOwnedChatThread(
  tx: Prisma.TransactionClient,
  userId: string,
  threadId: string,
): Promise<{ id: string; headMessageId: string | null } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; headMessageId: string | null }>>(
    Prisma.sql`
      SELECT "id", "headMessageId"
      FROM "ChatThread"
      WHERE "id" = ${threadId} AND "userId" = ${userId}
      FOR UPDATE
    `,
  );
  return rows[0] ?? null;
}

function validateMessageId(messageId: string): void {
  if (!messageId || messageId.length > MAX_ID_LENGTH) {
    throw new ChatMessageValidationError(
      `Message ids must contain 1 to ${MAX_ID_LENGTH} characters.`,
    );
  }
}

function firstTextPart(parts: Prisma.JsonValue | undefined): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      return part.text;
    }
  }
  return undefined;
}

function topologicallyOrderMessages(messages: StoredChatMessage[]): StoredChatMessage[] {
  const byParent = new Map<string | null, StoredChatMessage[]>();
  for (const message of messages) {
    const parent =
      message.parentId && messages.some(({ id }) => id === message.parentId)
        ? message.parentId
        : null;
    const children = byParent.get(parent) ?? [];
    children.push(message);
    byParent.set(parent, children);
  }
  const ordered: StoredChatMessage[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null) => {
    for (const message of byParent.get(parentId) ?? []) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      ordered.push(message);
      visit(message.id);
    }
  };
  visit(null);
  for (const message of messages) {
    if (!seen.has(message.id)) ordered.push(message);
  }
  return ordered;
}
