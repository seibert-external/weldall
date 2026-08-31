import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import {
  ChatMessageLimitError,
  ChatMessageValidationError,
  ChatThreadCursorError,
  createChatThread,
  deleteChatMessages,
  deleteChatThread,
  getChatThread,
  listChatThreads,
  renameChatThread,
  setChatThreadArchived,
  setChatThreadHead,
  upsertChatMessage,
} from "../src/server/ai/chat-threads";

const runId = randomUUID();
const primaryUserId = `chat-primary-${runId}`;
const secondaryUserId = `chat-secondary-${runId}`;

beforeAll(async () => {
  await db.user.createMany({
    data: [
      {
        id: primaryUserId,
        name: "Chat Primary",
        email: `${primaryUserId}@example.com`,
        emailVerified: true,
      },
      {
        id: secondaryUserId,
        name: "Chat Secondary",
        email: `${secondaryUserId}@example.com`,
        emailVerified: true,
      },
    ],
  });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [primaryUserId, secondaryUserId] } } });
});

describe("chat thread persistence", () => {
  it("isolates CRUD and paginated lists by user", async () => {
    const first = await createChatThread(primaryUserId);
    const second = await createChatThread(primaryUserId);
    const foreign = await createChatThread(secondaryUserId);
    await db.chatThread.update({
      where: { id: first.id },
      data: { lastMessageAt: new Date("2026-03-01T10:00:00.000Z") },
    });
    await db.chatThread.update({
      where: { id: second.id },
      data: { lastMessageAt: new Date("2026-03-01T11:00:00.000Z") },
    });

    const pageOne = await listChatThreads(primaryUserId, { limit: 1 });
    expect(pageOne.threads.map(({ id }) => id)).toEqual([second.id]);
    expect(pageOne.nextCursor).toBeDefined();
    const pageTwo = await listChatThreads(primaryUserId, {
      limit: 1,
      after: pageOne.nextCursor,
    });
    expect(pageTwo.threads.map(({ id }) => id)).toEqual([first.id]);
    expect(pageTwo.threads.some(({ id }) => id === foreign.id)).toBe(false);

    await expect(renameChatThread(primaryUserId, foreign.id, "No access")).resolves.toBe(false);
    await expect(setChatThreadArchived(primaryUserId, foreign.id, true)).resolves.toBe(false);
    await expect(setChatThreadHead(primaryUserId, foreign.id, null)).resolves.toBe(false);
    await expect(deleteChatThread(primaryUserId, foreign.id)).resolves.toBe(false);
    await expect(getChatThread(primaryUserId, foreign.id)).resolves.toBeNull();

    await expect(setChatThreadArchived(primaryUserId, second.id, true)).resolves.toBe(true);
    const regular = await listChatThreads(primaryUserId);
    expect(regular.threads.some(({ id }) => id === second.id)).toBe(false);
    const all = await listChatThreads(primaryUserId, { includeArchived: true });
    expect(all.threads.some(({ id }) => id === second.id)).toBe(true);
  });

  it("round-trips ordered tool message parts and idempotent updates", async () => {
    const thread = await createChatThread(primaryUserId);
    const userMessage = {
      id: "user-message",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Find expense skills" }],
    };
    const assistantMessage = {
      id: "assistant-message",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-searchSkills" as const,
          toolCallId: "call-1",
          state: "output-available" as const,
          input: { query: "expenses" },
          output: { skills: [] },
        },
      ],
    };
    await upsertChatMessage(primaryUserId, thread.id, userMessage, null);
    await upsertChatMessage(primaryUserId, thread.id, assistantMessage, userMessage.id);
    await upsertChatMessage(
      primaryUserId,
      thread.id,
      { ...assistantMessage, parts: [...assistantMessage.parts, { type: "text", text: "Done" }] },
      userMessage.id,
    );

    const restored = await getChatThread(primaryUserId, thread.id);
    expect(restored?.messages.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: userMessage.id, parentId: null },
      { id: assistantMessage.id, parentId: userMessage.id },
    ]);
    expect(restored?.messages[1]?.parts).toEqual([
      assistantMessage.parts[0],
      { type: "text", text: "Done" },
    ]);
    await expect(db.chatMessage.count({ where: { threadId: thread.id } })).resolves.toBe(2);
    expect(restored?.headMessageId).toBe(assistantMessage.id);
  });

  it("persists branch heads and moves the head to a surviving ancestor on delete", async () => {
    const thread = await createChatThread(primaryUserId);
    const userMessage = {
      id: `branch-user-${runId}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Choose a branch" }],
    };
    const firstBranch = {
      id: `branch-first-${runId}`,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "First" }],
    };
    const secondBranch = {
      id: `branch-second-${runId}`,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Second" }],
    };
    await upsertChatMessage(primaryUserId, thread.id, userMessage, null);
    await upsertChatMessage(primaryUserId, thread.id, firstBranch, userMessage.id);
    await upsertChatMessage(primaryUserId, thread.id, secondBranch, userMessage.id);

    await expect(setChatThreadHead(primaryUserId, thread.id, firstBranch.id)).resolves.toBe(true);
    expect((await getChatThread(primaryUserId, thread.id))?.headMessageId).toBe(firstBranch.id);
    await deleteChatMessages(primaryUserId, thread.id, [firstBranch.id]);
    expect((await getChatThread(primaryUserId, thread.id))?.headMessageId).toBe(userMessage.id);

    await expect(setChatThreadHead(primaryUserId, thread.id, secondBranch.id)).resolves.toBe(true);
    await deleteChatMessages(primaryUserId, thread.id, [userMessage.id]);
    const restored = await getChatThread(primaryUserId, thread.id);
    expect(restored?.headMessageId).toBeNull();
    expect(restored?.messages).toEqual([]);
  });

  it("validates branch membership and enforces parent ancestry in PostgreSQL", async () => {
    const thread = await createChatThread(primaryUserId);
    await expect(
      setChatThreadHead(primaryUserId, thread.id, "missing-head"),
    ).rejects.toBeInstanceOf(ChatMessageValidationError);
    await expect(
      db.chatMessage.create({
        data: {
          id: `orphan-${runId}`,
          threadId: thread.id,
          parentId: "missing-parent",
          role: "user",
          parts: [{ type: "text", text: "Orphan" }],
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("caps new persisted messages at 100 while allowing updates", async () => {
    const thread = await createChatThread(primaryUserId);
    await db.chatMessage.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `limit-${index}`,
        threadId: thread.id,
        role: "user",
        parts: [{ type: "text", text: String(index) }],
      })),
    });

    await expect(
      upsertChatMessage(
        primaryUserId,
        thread.id,
        { id: "limit-0", role: "user", parts: [{ type: "text", text: "updated" }] },
        null,
      ),
    ).resolves.toBeUndefined();
    await expect(
      upsertChatMessage(
        primaryUserId,
        thread.id,
        { id: "limit-new", role: "user", parts: [{ type: "text", text: "new" }] },
        null,
      ),
    ).rejects.toBeInstanceOf(ChatMessageLimitError);
    await expect(db.chatMessage.count({ where: { threadId: thread.id } })).resolves.toBe(100);
  });

  it("rejects forged noncanonical and out-of-range cursors before querying", async () => {
    const cursor = (lastMessageAt: string, id = "thread") =>
      Buffer.from(JSON.stringify({ lastMessageAt, id })).toString("base64url");
    for (const forged of [
      cursor("2026-03-01"),
      cursor("0000-01-01T00:00:00.000Z"),
      cursor("2026-03-01T00:00:00.000Z", ""),
      cursor("2026-03-01T00:00:00.000Z", "x".repeat(129)),
    ]) {
      await expect(listChatThreads(primaryUserId, { after: forged })).rejects.toBeInstanceOf(
        ChatThreadCursorError,
      );
    }
  });
});
