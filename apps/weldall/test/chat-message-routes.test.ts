import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ChatThreadNotFoundError extends Error {}
  class ChatMessageValidationError extends Error {}
  class ChatMessageLimitError extends Error {}
  return {
    ChatThreadNotFoundError,
    ChatMessageValidationError,
    ChatMessageLimitError,
    getSession: vi.fn(),
    upsertChatMessage: vi.fn(),
    deleteChatMessages: vi.fn(),
  };
});

vi.mock("../src/server/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("../src/server/ai/chat-threads", () => ({
  ChatThreadNotFoundError: mocks.ChatThreadNotFoundError,
  ChatMessageValidationError: mocks.ChatMessageValidationError,
  ChatMessageLimitError: mocks.ChatMessageLimitError,
  upsertChatMessage: mocks.upsertChatMessage,
  deleteChatMessages: mocks.deleteChatMessages,
}));

import { DELETE, POST } from "../src/app/api/chat/threads/[threadId]/messages/route";
import { WELDALL_ISSUER } from "../src/server/oauth/constants";

const session = {
  user: { id: "user-1", email: "user@example.com", emailVerified: true, name: "User" },
};
const context = { params: Promise.resolve({ threadId: "thread-1" }) };

function request(
  method: "POST" | "DELETE",
  body: unknown,
  options: { csrf?: boolean; origin?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: options.origin ?? new URL(WELDALL_ISSUER).origin,
    "sec-fetch-site": "same-origin",
  };
  if (options.csrf !== false) headers["x-weldall-csrf"] = "1";
  return new Request("https://weldall.example/api/chat/threads/thread-1/messages", {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

describe("chat message routes", () => {
  beforeEach(() => {
    mocks.getSession.mockReset().mockResolvedValue(session);
    mocks.upsertChatMessage.mockReset().mockResolvedValue(undefined);
    mocks.deleteChatMessages.mockReset().mockResolvedValue(undefined);
  });

  it("requires authentication and CSRF before message writes", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect(
      (
        await POST(
          request("POST", {
            parentId: null,
            message: { id: "message-1", role: "user", parts: [{ type: "text", text: "Hi" }] },
          }),
          context,
        )
      ).status,
    ).toBe(401);
    expect(mocks.upsertChatMessage).not.toHaveBeenCalled();

    expect(
      (
        await POST(
          request(
            "POST",
            {
              parentId: null,
              message: {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }],
              },
            },
            { csrf: false },
          ),
          context,
        )
      ).status,
    ).toBe(403);

    mocks.getSession.mockResolvedValueOnce(null);
    expect((await DELETE(request("DELETE", { ids: ["message-1"] }), context)).status).toBe(401);
    expect(
      (await DELETE(request("DELETE", { ids: ["message-1"] }, { csrf: false }), context)).status,
    ).toBe(403);
    expect(mocks.upsertChatMessage).not.toHaveBeenCalled();
    expect(mocks.deleteChatMessages).not.toHaveBeenCalled();
  });

  it("rejects malformed append and delete bodies", async () => {
    expect((await POST(request("POST", { message: null }), context)).status).toBe(400);
    expect((await DELETE(request("DELETE", { ids: [""] }), context)).status).toBe(400);
    expect(mocks.upsertChatMessage).not.toHaveBeenCalled();
    expect(mocks.deleteChatMessages).not.toHaveBeenCalled();
  });

  it("propagates the authenticated user, thread, parent, and sanitized tool parts", async () => {
    const message = {
      id: "assistant-message",
      role: "assistant",
      parts: [
        {
          type: "tool-searchSkills",
          toolCallId: "call-1",
          state: "output-available",
          input: { query: "expenses" },
          output: { skills: [] },
          callProviderMetadata: { provider: { unsafe: true } },
        },
      ],
    };
    const response = await POST(request("POST", { parentId: "user-message", message }), context);

    expect(response.status).toBe(204);
    expect(mocks.upsertChatMessage).toHaveBeenCalledWith(
      "user-1",
      "thread-1",
      {
        id: message.id,
        role: message.role,
        parts: [
          {
            type: "tool-searchSkills",
            toolCallId: "call-1",
            state: "output-available",
            input: { query: "expenses" },
            output: { skills: [] },
          },
        ],
      },
      "user-message",
    );
  });

  it("maps not-found, validation, and history-limit domain errors", async () => {
    mocks.upsertChatMessage.mockRejectedValueOnce(new mocks.ChatThreadNotFoundError());
    expect(
      (
        await POST(
          request("POST", {
            parentId: null,
            message: { id: "message-1", role: "user", parts: [{ type: "text", text: "Hi" }] },
          }),
          context,
        )
      ).status,
    ).toBe(404);

    mocks.upsertChatMessage.mockRejectedValueOnce(
      new mocks.ChatMessageValidationError("Message parent was not found."),
    );
    const invalid = await POST(
      request("POST", {
        parentId: "missing",
        message: { id: "message-2", role: "user", parts: [{ type: "text", text: "Hi" }] },
      }),
      context,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Message parent was not found." });

    mocks.upsertChatMessage.mockRejectedValueOnce(new mocks.ChatMessageLimitError("limit"));
    const limited = await POST(
      request("POST", {
        parentId: null,
        message: { id: "message-3", role: "user", parts: [{ type: "text", text: "Hi" }] },
      }),
      context,
    );
    expect(limited.status).toBe(409);

    mocks.deleteChatMessages.mockRejectedValueOnce(new mocks.ChatThreadNotFoundError());
    expect((await DELETE(request("DELETE", { ids: ["message-1"] }), context)).status).toBe(404);
    mocks.deleteChatMessages.mockRejectedValueOnce(
      new mocks.ChatMessageValidationError("Invalid message id."),
    );
    const invalidDelete = await DELETE(request("DELETE", { ids: ["message-1"] }), context);
    expect(invalidDelete.status).toBe(400);
  });

  it("propagates delete ids and rethrows unexpected operational errors", async () => {
    const deleted = await DELETE(request("DELETE", { ids: ["message-1"] }), context);
    expect(deleted.status).toBe(204);
    expect(mocks.deleteChatMessages).toHaveBeenCalledWith("user-1", "thread-1", ["message-1"]);

    mocks.upsertChatMessage.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      POST(
        request("POST", {
          parentId: null,
          message: { id: "message-4", role: "user", parts: [{ type: "text", text: "Hi" }] },
        }),
        context,
      ),
    ).rejects.toThrow("database unavailable");
  });
});
