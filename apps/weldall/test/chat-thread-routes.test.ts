import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listChatThreads: vi.fn(),
  createChatThread: vi.fn(),
  getChatThread: vi.fn(),
  renameChatThread: vi.fn(),
  setChatThreadArchived: vi.fn(),
  setChatThreadHead: vi.fn(),
  deleteChatThread: vi.fn(),
  generateChatThreadTitle: vi.fn(),
}));

vi.mock("../src/server/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("../src/server/ai/chat-threads", () => ({
  ChatMessageValidationError: class extends Error {},
  ChatThreadCursorError: class extends Error {},
  ChatThreadNotFoundError: class extends Error {},
  ChatThreadValidationError: class extends Error {},
  listChatThreads: mocks.listChatThreads,
  createChatThread: mocks.createChatThread,
  getChatThread: mocks.getChatThread,
  renameChatThread: mocks.renameChatThread,
  setChatThreadArchived: mocks.setChatThreadArchived,
  setChatThreadHead: mocks.setChatThreadHead,
  deleteChatThread: mocks.deleteChatThread,
  generateChatThreadTitle: mocks.generateChatThreadTitle,
}));

import { GET as LIST, POST as CREATE } from "../src/app/api/chat/threads/route";
import { ChatThreadValidationError } from "../src/server/ai/chat-threads";
import {
  DELETE as REMOVE,
  GET as FETCH,
  PATCH as UPDATE,
} from "../src/app/api/chat/threads/[threadId]/route";
import { POST as TITLE } from "../src/app/api/chat/threads/[threadId]/title/route";
import { WELDALL_ISSUER } from "../src/server/oauth/constants";

const session = {
  user: { id: "user-1", email: "user@example.com", emailVerified: true, name: "User" },
};
const metadata = {
  id: "thread-1",
  title: "A thread",
  archivedAt: null,
  headMessageId: null,
  lastMessageAt: new Date("2026-03-01T12:00:00.000Z"),
};
const context = { params: Promise.resolve({ threadId: "thread-1" }) };

function request(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
  origin = new URL(WELDALL_ISSUER).origin,
) {
  return new Request(`https://weldall.example${path}`, {
    method,
    ...(method === "GET"
      ? {}
      : {
          headers: {
            "content-type": "application/json",
            origin,
            "sec-fetch-site": "same-origin",
            "x-weldall-csrf": "1",
          },
          body: JSON.stringify(body ?? {}),
        }),
  });
}

describe("chat thread routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getSession.mockResolvedValue(session);
    mocks.listChatThreads.mockResolvedValue({ threads: [metadata], nextCursor: "next" });
    mocks.createChatThread.mockResolvedValue(metadata);
    mocks.getChatThread.mockResolvedValue({ ...metadata, messages: [] });
    mocks.renameChatThread.mockResolvedValue(true);
    mocks.setChatThreadArchived.mockResolvedValue(true);
    mocks.setChatThreadHead.mockResolvedValue(true);
    mocks.deleteChatThread.mockResolvedValue(true);
    mocks.generateChatThreadTitle.mockResolvedValue("Generated title");
  });

  it("requires authentication", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await LIST(request("/api/chat/threads"));
    expect(response.status).toBe(401);
    expect(mocks.listChatThreads).not.toHaveBeenCalled();
  });

  it("rejects untrusted mutations", async () => {
    const response = await CREATE(
      request("/api/chat/threads", "POST", {}, "https://attacker.example"),
    );
    expect(response.status).toBe(403);
    expect(mocks.createChatThread).not.toHaveBeenCalled();
  });

  it("lists a user page and serializes adapter metadata", async () => {
    const response = await LIST(
      request("/api/chat/threads?includeArchived=true&limit=1&after=cursor"),
    );
    expect(mocks.listChatThreads).toHaveBeenCalledWith("user-1", {
      after: "cursor",
      includeArchived: true,
      limit: 1,
    });
    await expect(response.json()).resolves.toEqual({
      threads: [
        {
          remoteId: "thread-1",
          status: "regular",
          title: "A thread",
          lastMessageAt: "2026-03-01T12:00:00.000Z",
        },
      ],
      nextCursor: "next",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("creates and mutates only through the authenticated user id", async () => {
    expect((await CREATE(request("/api/chat/threads", "POST", {}))).status).toBe(201);
    expect(mocks.createChatThread).toHaveBeenCalledWith("user-1");

    expect(
      (await UPDATE(request("/api/chat/threads/thread-1", "PATCH", { title: "Renamed" }), context))
        .status,
    ).toBe(204);
    expect(mocks.renameChatThread).toHaveBeenCalledWith("user-1", "thread-1", "Renamed");

    expect(
      (await UPDATE(request("/api/chat/threads/thread-1", "PATCH", { archived: true }), context))
        .status,
    ).toBe(204);
    expect(mocks.setChatThreadArchived).toHaveBeenCalledWith("user-1", "thread-1", true);

    expect(
      (
        await UPDATE(
          request("/api/chat/threads/thread-1", "PATCH", {
            headMessageId: "message-branch",
          }),
          context,
        )
      ).status,
    ).toBe(204);
    expect(mocks.setChatThreadHead).toHaveBeenCalledWith("user-1", "thread-1", "message-branch");

    expect(
      (await REMOVE(request("/api/chat/threads/thread-1", "DELETE", {}), context)).status,
    ).toBe(204);
    expect(mocks.deleteChatThread).toHaveBeenCalledWith("user-1", "thread-1");
  });

  it("maps only explicit validation errors and rethrows operational failures", async () => {
    mocks.renameChatThread.mockRejectedValueOnce(new ChatThreadValidationError("Invalid title."));
    const validation = await UPDATE(
      request("/api/chat/threads/thread-1", "PATCH", { title: "" }),
      context,
    );
    expect(validation.status).toBe(400);
    await expect(validation.json()).resolves.toEqual({ error: "Invalid title." });

    mocks.renameChatThread.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      UPDATE(request("/api/chat/threads/thread-1", "PATCH", { title: "Valid" }), context),
    ).rejects.toThrow("database unavailable");
  });

  it("returns the same 404 for an unavailable thread", async () => {
    mocks.getChatThread.mockResolvedValue(null);
    const response = await FETCH(request("/api/chat/threads/foreign"), context);
    expect(response.status).toBe(404);
    expect(mocks.getChatThread).toHaveBeenCalledWith("user-1", "thread-1");
  });

  it("generates and returns a persisted title", async () => {
    const response = await TITLE(
      request("/api/chat/threads/thread-1/title", "POST", { text: "Hello world" }),
      context,
    );
    await expect(response.json()).resolves.toEqual({ title: "Generated title" });
    expect(mocks.generateChatThreadTitle).toHaveBeenCalledWith("user-1", "thread-1", "Hello world");
  });
});
